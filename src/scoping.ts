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
 * CANARY (operator, 2026-11-01): the exact Cloudflare resource shapes below
 * are verified against the real API. A flat
 * `com.cloudflare.edge.worker.script.<id>` key FAILS token creation with
 * `500 1004 server error`, with either the script name or the tag as `<id>`;
 * the per-Worker allowance MUST be nested under
 * `com.cloudflare.api.account.<ACCOUNT>` and keyed on the script **tag**
 * (the upload response returns `id` = script name plus a separate `tag` =
 * Worker ID, e.g. `id=pct-canary`, `tag=3b278ba2...`). The flat R2 shape
 * (`com.cloudflare.edge.r2.bucket.<ACCOUNT>_default_<BUCKET>` with value
 * `"*"`, developers.cloudflare.com/r2/api/tokens, "Access Policy →
 * Bucket"). Change the builders in this file only if
 * a new canary shows the API shape drifted.
 */

export const WORKER_SCRIPT_RESOURCE = "com.cloudflare.edge.worker.script";
export const R2_BUCKET_RESOURCE = "com.cloudflare.edge.r2.bucket";
export const ACCOUNT_RESOURCE = "com.cloudflare.api.account";

/** Display names used to resolve permission group ids when no override is configured. */
export const WORKER_ADMIN_GROUP_NAME = "Individual Workers Admin";
export const R2_ITEM_WRITE_GROUP_NAME = "Workers R2 Storage Bucket Item Write";

export interface TokenPolicy {
  effect: "allow";
  resources: Record<string, string | Record<string, string>>;
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
 * Per-Worker resource, canary-verified 2026-11-01: the script tag nested under
 * the account key, `{ "com.cloudflare.api.account.<acct>":
 * { "com.cloudflare.edge.worker.script.<tag>": "*" } }`. A flat
 * `com.cloudflare.edge.worker.script.<id>` key — with either the script name
 * or the tag — is rejected by token creation (`500 1004`). The per-Worker
 * allowance applies to this Worker only. `workerTag` is the script `tag`
 * from the upload response, NOT the `id` (which is the script name).
 */
export function workerResource(
  accountId: string,
  workerTag: string,
): Record<string, Record<string, string>> {
  return { [`${ACCOUNT_RESOURCE}.${accountId}`]: { [`${WORKER_SCRIPT_RESOURCE}.${workerTag}`]: "*" } };
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
  /** Script `tag` from the upload response (the Worker ID), NOT the `id` (script name). */
  workerTag: string;
  bucketName: string;
  workerAdminGroupId: string;
  r2ItemWriteGroupId: string;
}): TokenPolicy[] {
  return [
    {
      effect: "allow",
      resources: workerResource(opts.accountId, opts.workerTag),
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
 * Canonical form of one CIDR for comparison, or `null` when the input does
 * not parse as a CIDR (or bare host address). Cloudflare may store the token
 * IP condition in a different-but-equivalent spelling than the one requested
 * — expanded IPv6 groups, upper-case hex, leading zeros, host bits shown —
 * so verification compares canonical forms, not raw strings: lowercase,
 * RFC 5952-compressed IPv6, host bits masked off to the prefix length. A
 * bare address means the full-length host prefix (`/32` or `/128`).
 * Anything unparsable returns `null` and can never match (fail closed).
 */
export function normalizeCidr(cidr: unknown): string | null {
  if (typeof cidr !== "string") return null;
  const parts = cidr.trim().split("/");
  if (parts.length > 2 || !parts[0]) return null;
  const address = parts[0];
  const bits = address.includes(":") ? 128 : address.includes(".") ? 32 : 0;
  if (bits === 0) return null;
  let prefix = bits;
  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[1]!)) return null;
    prefix = Number(parts[1]);
    if (prefix > bits) return null;
  }
  const value = bits === 32 ? parseIpv4(address) : parseIpv6(address);
  if (value === null) return null;
  const hostBits = BigInt(bits - prefix);
  const network = (value >> hostBits) << hostBits;
  const rendered = bits === 32 ? formatIpv4(network) : formatIpv6(network);
  return `${rendered}/${prefix}`;
}

/** Parse dotted-quad IPv4 to a 32-bit value. Leading zeros are rejected:
 * some parsers read them as octal, so accepting them could equate two
 * different networks. */
function parseIpv4(address: string): bigint | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  let value = 0n;
  for (const octet of octets) {
    if (!/^(0|[1-9]\d{0,2})$/.test(octet)) return null;
    const n = Number(octet);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/** Parse IPv6 (with `::` compression and an optional embedded IPv4 tail)
 * to a 128-bit value. */
function parseIpv6(address: string): bigint | null {
  let rest = address;
  if (rest.includes("%")) return null; // zone ids are not valid in a CIDR
  // Embedded IPv4 tail (e.g. `::ffff:192.0.2.1`): expand to two hex groups.
  const lastColon = rest.lastIndexOf(":");
  if (lastColon !== -1 && rest.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(rest.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >> 16n) & 0xffffn).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    rest = `${rest.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0]!);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const tail = parseGroups(halves[1]!);
    if (tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` must stand for at least one group
    groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return value;
}

/** RFC 5952 rendering: lowercase, no leading zeros, the longest run of two
 * or more zero groups (first one on a tie) compressed to `::`. */
function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  }
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (runStart === -1) runStart = i;
      runLen++;
      if (runLen > bestLen) {
        bestStart = runStart;
        bestLen = runLen;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

/**
 * Verify the token the API actually minted, right after creation. A wrong
 * request shape can pass every unit test and still produce a weaker token
 * (e.g. an ignored condition key), so provision fails closed unless the stored
 * token shows: the exact egress CIDR list under `"request.ip"` — the same
 * networks after canonicalisation (`normalizeCidr`), same count, any order,
 * so an equivalently-spelled list from Cloudflare passes while a genuinely
 * different one still fails — an expiry no later than requested, and exactly the two policies
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
  // Compare canonical CIDRs as a multiset: equivalent spellings of the same
  // networks match, but a different network, prefix length, or count (a
  // duplicated entry included) still fails. An unparsable entry on either
  // side normalizes to `null`, which never equals a canonical form.
  const granted = within.map(normalizeCidr);
  const wantedCidrs = expected.egressCidrs.map(normalizeCidr);
  const sortedWanted = [...wantedCidrs].sort();
  const sameMembers =
    granted.length === wantedCidrs.length &&
    granted.every((v) => v !== null) &&
    [...granted].sort().every((v, i) => v === sortedWanted[i]);
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
