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
   * token. The list must cover every egress path of the host (e.g. its IPv4
   * /32 AND its IPv6 /64): a token filtered to only one family 401s on the
   * other, and repeated 401s lock the caller out. */
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
  egressCidrs: string[];
}): TokenRequest {
  if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be a positive integer");
  }
  if (!Array.isArray(opts.egressCidrs) || opts.egressCidrs.length === 0) {
    throw new Error("egressCidrs is required: refusing to mint an unfiltered token");
  }
  for (const cidr of opts.egressCidrs) {
    if (typeof cidr !== "string" || !cidr.trim()) {
      throw new Error("egressCidrs must not contain empty entries: refusing to mint a misfiltered token");
    }
  }
  if (opts.policies.length === 0) {
    throw new Error("refusing to mint a token with no policies");
  }
  return {
    name: opts.name,
    policies: opts.policies,
    not_before: toCloudflareTimestamp(opts.nowMs),
    expires_on: toCloudflareTimestamp(opts.nowMs + opts.ttlSeconds * 1000),
    condition: { "request.ip": { in: [...opts.egressCidrs] } },
  };
}

/**
 * Verify the token the API actually minted, right after creation. A wrong
 * request shape can pass every unit test and still produce a weaker token
 * (e.g. an ignored condition key), so provision fails closed unless the stored
 * token shows: the exact egress CIDR list under `"request.ip"` (same members,
 * any order), an expiry no later than requested, and exactly the two policies
 * built above — compared whole, not just by resource key. A key-only check
 * would pass a token whose stored policy kept the key but widened the value
 * (e.g. a nested `com.cloudflare.api.account.<id>: "*"` covering the whole
 * account) or swapped in a broader permission group. Throws on any mismatch;
 * the caller revokes and rolls back.
 */
export function assertMintedTokenMatches(
  actual: unknown,
  expected: { policies: TokenPolicy[]; expiresOn: string; egressCidrs: string[] },
): void {
  const fail = (detail: string): never => {
    throw new Error(`minted token failed verification (${detail}); refusing to hand it out`);
  };
  const rec = (actual ?? {}) as Record<string, unknown>;
  const condition = (rec.condition ?? {}) as Record<string, unknown>;
  const reqIp = (condition["request.ip"] ?? {}) as Record<string, unknown>;
  const within = Array.isArray(reqIp.in) ? reqIp.in : [];
  const sameMembers =
    within.length === expected.egressCidrs.length &&
    [...within].sort().every((v, i) => v === [...expected.egressCidrs].sort()[i]);
  if (!sameMembers) {
    fail("IP condition is not exactly the requested egress CIDR list");
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
  // Whole-policy comparison: effect, the FULL resources object (keys and
  // nested values), and the sorted permission-group ids. Order-independent
  // across the policy list, exact within each policy.
  const normalised = (policies as unknown[]).map(normalisePolicy).map((p) => JSON.stringify(p)).sort();
  const wanted = expected.policies.map(normalisePolicy).map((p) => JSON.stringify(p)).sort();
  if (JSON.stringify(normalised) !== JSON.stringify(wanted)) {
    fail("stored token policies differ from those requested");
  }
}

/** Canonical form of one token policy for exact comparison. */
function normalisePolicy(p: unknown): { effect: string; resources: unknown; groupIds: string[] } {
  const rec = (p ?? {}) as Record<string, unknown>;
  const groups = rec.permission_groups;
  const groupIds = Array.isArray(groups)
    ? groups
        .map((g) => (g as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === "string")
        .sort()
    : [];
  return {
    effect: typeof rec.effect === "string" ? rec.effect : "",
    resources: canonicalValue(rec.resources ?? {}),
    groupIds,
  };
}

/** Recursively sort object keys so structurally-equal values stringify equally. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalValue(v)]));
  }
  return value;
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
