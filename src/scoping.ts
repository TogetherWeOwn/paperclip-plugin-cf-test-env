/**
 * Token scoping: the security core of this plugin.
 *
 * A provisioned token carries exactly two allowances:
 * - Individual Workers Admin on ONE Worker ID (deploy, rollback, secret
 *   put/delete, delete that Worker — nothing else);
 * - Workers R2 Storage Bucket Item Write on ONE bucket.
 *
 * D1 and KV have no per-resource roles (Cloudflare roadmap), so agents never
 * get account-wide D1/KV write: D1 goes through the `d1_execute` tool, which
 * the worker pins to the env's database id.
 *
 * CANARY NOTE: the exact Cloudflare resource-identifier strings below follow
 * the documented R2 shape (`com.cloudflare.edge.r2.bucket.<ACCOUNT>_<BUCKET>`
 * with value `"*"`, developers.cloudflare.com/r2/api/tokens, "Access Policy →
 * Bucket"). The per-Worker key is inferred by analogy
 * (`com.cloudflare.edge.worker.script.<WORKER_ID>` with value `"*"`) because
 * the Workers authorization docs don't publish the single-Worker key; confirm
 * it by reading the policy of a dashboard-made per-Worker token via
 * `GET /accounts/{id}/tokens/{tokenId}`. The merge gate requires the operator
 * to verify a minted token against the real API (deploy/secret/delete on the
 * stub Worker, 403 on production); if the API shape differs, change ONLY the
 * builders in this file.
 */

export const WORKER_SCRIPT_RESOURCE = "com.cloudflare.edge.worker.script";
export const R2_BUCKET_RESOURCE = "com.cloudflare.edge.r2.bucket";

/** Display names used to resolve permission group ids when no override is configured. */
export const WORKER_ADMIN_GROUP_NAME = "Individual Workers Admin";
export const R2_ITEM_WRITE_GROUP_NAME = "Workers R2 Storage Bucket Item Write";

export interface TokenPolicy {
  effect: "allow";
  resources: Record<string, string>;
  permission_groups: Array<{ id: string }>;
}

export interface TokenRequest {
  name: string;
  policies: TokenPolicy[];
  expires_on: string;
  not_before: string;
  /** Dotted key is what Cloudflare documents (`"request.ip"`); `request_ip`
   * with an underscore is silently ignored, which would mint an unfiltered
   * token. */
  condition: { "request.ip": { in: string[] } };
}

/** Worker names are lowercase alphanumerics and dashes (Cloudflare script-name rule). */
export const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

export function isValidWorkerName(name: string): boolean {
  return WORKER_NAME_RE.test(name) && name.length <= 63;
}

/**
 * Build a deterministic, prefix-scoped worker name from the issue id plus
 * randomness. The random suffix keeps names unique across re-provisions of
 * the same card; the issue fragment keeps them attributable for the sweeper.
 */
export function workerNameFor(prefix: string, issueId: string, randHex: string): string {
  const short = issueId.replace(/-/g, "").slice(0, 8).toLowerCase();
  const rand = randHex.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(6, "0");
  const name = `${prefix}${short}-${rand}`.toLowerCase();
  if (!isValidWorkerName(name)) {
    throw new Error(`Cannot derive a valid worker name from prefix ${JSON.stringify(prefix)}`);
  }
  return name;
}

/**
 * Per-Worker resource: `<type>.<workerId>` with value `"*"`, mirroring the
 * documented R2 shape. The per-Worker allowance applies to this Worker only.
 * `accountId` is kept so the key can be re-nested under
 * `com.cloudflare.api.account.<id>` if the canary shows Cloudflare requires it.
 */
export function workerResource(accountId: string, workerId: string): Record<string, string> {
  void accountId;
  return { [`${WORKER_SCRIPT_RESOURCE}.${workerId}`]: "*" };
}

/**
 * Documented R2 shape: `com.cloudflare.edge.r2.bucket.<ACCOUNT>_default_<BUCKET>`
 * with value `"*"`. Item Write applies to this bucket only.
 */
export function r2BucketResource(accountId: string, bucketName: string): Record<string, string> {
  return { [`${R2_BUCKET_RESOURCE}.${accountId}_default_${bucketName}`]: "*" };
}

export function buildTokenPolicies(opts: {
  accountId: string;
  workerId: string;
  bucketName: string;
  workerAdminGroupId: string;
  r2ItemWriteGroupId: string;
}): TokenPolicy[] {
  return [
    {
      effect: "allow",
      resources: workerResource(opts.accountId, opts.workerId),
      permission_groups: [{ id: opts.workerAdminGroupId }],
    },
    {
      effect: "allow",
      resources: r2BucketResource(opts.accountId, opts.bucketName),
      permission_groups: [{ id: opts.r2ItemWriteGroupId }],
    },
  ];
}

/**
 * Cloudflare documents `expires_on`/`not_before` as `"2018-07-01T05:20:00Z"`
 * with no milliseconds. `toISOString()` produces `.000Z`; strip the fraction
 * so the API can never read the timestamp in a lenient or odd way.
 */
export function toCloudflareTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildTokenRequest(opts: {
  name: string;
  policies: TokenPolicy[];
  nowMs: number;
  ttlSeconds: number;
  egressCidr: string;
}): TokenRequest {
  if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be a positive integer");
  }
  if (!opts.egressCidr) {
    throw new Error("egressCidr is required: refusing to mint an unfiltered token");
  }
  if (opts.policies.length === 0) {
    throw new Error("refusing to mint a token with no policies");
  }
  return {
    name: opts.name,
    policies: opts.policies,
    not_before: toCloudflareTimestamp(opts.nowMs),
    expires_on: toCloudflareTimestamp(opts.nowMs + opts.ttlSeconds * 1000),
    condition: { "request.ip": { in: [opts.egressCidr] } },
  };
}

/**
 * Verify the token the API actually minted, right after creation. A wrong
 * request shape can pass every unit test and still produce a weaker token
 * (e.g. an ignored condition key), so provision fails closed unless the stored
 * token shows: the exact egress CIDR under `"request.ip"`, an expiry no later
 * than requested, exactly 2 policies, and exactly the resource keys built
 * above. Throws on any mismatch; the caller revokes and rolls back.
 */
export function assertMintedTokenMatches(
  actual: unknown,
  expected: { policies: TokenPolicy[]; expiresOn: string; egressCidr: string },
): void {
  const fail = (detail: string): never => {
    throw new Error(`minted token failed verification (${detail}); refusing to hand it out`);
  };
  const rec = (actual ?? {}) as Record<string, unknown>;
  const condition = (rec.condition ?? {}) as Record<string, unknown>;
  const reqIp = (condition["request.ip"] ?? {}) as Record<string, unknown>;
  const within = Array.isArray(reqIp.in) ? reqIp.in : [];
  if (within.length !== 1 || within[0] !== expected.egressCidr) {
    fail("IP condition is not exactly the requested egress CIDR");
  }
  const expiresOn = rec.expires_on;
  if (
    typeof expiresOn !== "string" ||
    Number.isNaN(Date.parse(expiresOn)) ||
    Date.parse(expiresOn) > Date.parse(expected.expiresOn)
  ) {
    fail("expiry is missing, unparsable, or later than requested");
  }
  const policies = rec.policies;
  if (!Array.isArray(policies) || policies.length !== 2) {
    fail(`expected exactly 2 policies, saw ${Array.isArray(policies) ? policies.length : typeof policies}`);
  }
  const keyOf = (p: unknown): string =>
    Object.keys(((p as Record<string, unknown>).resources ?? {}) as Record<string, unknown>)
      .sort()
      .join(",");
  const actualKeys = (policies as unknown[]).map(keyOf).sort();
  const expectedKeys = expected.policies.map(keyOf).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail("policy resource keys differ from those requested");
  }
}

/** Clamp the requested TTL to the configured max; reject non-positive values. */
export function clampTtl(requested: number | undefined, maxTtlSeconds: number): number {
  if (requested === undefined) return maxTtlSeconds;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error("ttlSeconds must be a positive integer");
  }
  if (requested > maxTtlSeconds) {
    throw new Error(`ttlSeconds ${requested} exceeds the maximum ${maxTtlSeconds}`);
  }
  return requested;
}
