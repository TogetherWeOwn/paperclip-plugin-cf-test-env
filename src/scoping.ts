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
 * CANARY NOTE: the exact Cloudflare resource-identifier strings below
 * (`com.cloudflare.edge.worker.script` nested `accountId/workerId`, and the
 * R2 bucket resource) encode the operator's 2026-11-01 research. The merge
 * gate requires the operator to verify a minted token against the real API
 * (deploy/secret/delete on the stub Worker, 403 on production); if the API
 * shape differs, change ONLY the builders in this file.
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
  condition: { request_ip: { in: string[] } };
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

/** `accountId/workerId` nesting: the per-Worker role applies to this Worker only. */
export function workerResource(accountId: string, workerId: string): Record<string, string> {
  return { [WORKER_SCRIPT_RESOURCE]: `${accountId}/${workerId}` };
}

/** `accountId/bucketName` nesting: Item Write applies to this bucket only. */
export function r2BucketResource(accountId: string, bucketName: string): Record<string, string> {
  return { [R2_BUCKET_RESOURCE]: `${accountId}/${bucketName}` };
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
    not_before: new Date(opts.nowMs).toISOString(),
    expires_on: new Date(opts.nowMs + opts.ttlSeconds * 1000).toISOString(),
    condition: { request_ip: { in: [opts.egressCidr] } },
  };
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
