import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

export interface CfTestEnvConfig {
  /** Company secret binding for the minting credential. Null means unconfigured: fail closed. */
  tokenSecretRef: EnvSecretRefBinding | null;
  accountId: string;
  allowedProjectIds: string[];
  namePrefix: string;
  maxTtlSeconds: number;
  maxConcurrentEnvs: number;
  /**
   * Egress CIDRs for the token `request.ip` filter. Must cover every egress
   * path of the host (e.g. its IPv4 /32 AND its IPv6 /64): a token filtered
   * to only one family 401s on the other, and repeated 401s lock the caller
   * out of the Cloudflare API.
   */
  egressCidrs: string[];
  workerAdminGroupId: string;
  r2ItemWriteGroupId: string;
}

export const DEFAULT_NAME_PREFIX = "pct-";
export const DEFAULT_MAX_TTL_SECONDS = 10800; // 3 h
export const DEFAULT_MAX_CONCURRENT_ENVS = 10;

/**
 * Allowed `namePrefix` values: lowercase, short, and always dash-terminated.
 * The pattern keeps provisioned names attributable (`pct-*`) and rejects
 * prefixes that could collide with real (non-test) Workers.
 */
export const NAME_PREFIX_RE = /^[a-z][a-z0-9]{1,10}-$/;

export function isValidNamePrefix(prefix: string): boolean {
  return NAME_PREFIX_RE.test(prefix);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];

const isSecretRefBinding = (value: unknown): value is EnvSecretRefBinding => {
  if (!isRecord(value)) return false;
  return (
    value.type === "secret_ref" &&
    typeof value.secretId === "string" &&
    value.secretId.length > 0
  );
};

const intOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;

/** Resolve operator config with the documented defaults. Unknown keys are ignored. */
export function resolveConfig(raw: Record<string, unknown>): CfTestEnvConfig {
  const prefix =
    typeof raw.namePrefix === "string" && raw.namePrefix.length > 0 ? raw.namePrefix : DEFAULT_NAME_PREFIX;
  // `egressCidrs` (list) is canonical; a legacy single `egressCidr` string is
  // merged in so configs written before the list existed keep working.
  const legacy = typeof raw.egressCidr === "string" ? raw.egressCidr.trim() : "";
  const cidrs = [legacy, ...stringArray(raw.egressCidrs)]
    .map((c) => c.trim())
    .filter((c, i, a) => c.length > 0 && a.indexOf(c) === i);
  return {
    tokenSecretRef: isSecretRefBinding(raw.tokenSecretRef) ? raw.tokenSecretRef : null,
    accountId: typeof raw.accountId === "string" ? raw.accountId.trim() : "",
    allowedProjectIds: stringArray(raw.allowedProjectIds),
    namePrefix: prefix,
    // Hard cap: the issue requires expiry within 3 h, so a larger configured
    // max is clamped rather than honoured.
    maxTtlSeconds: Math.min(intOr(raw.maxTtlSeconds, DEFAULT_MAX_TTL_SECONDS), DEFAULT_MAX_TTL_SECONDS),
    maxConcurrentEnvs: intOr(raw.maxConcurrentEnvs, DEFAULT_MAX_CONCURRENT_ENVS),
    egressCidrs: cidrs,
    workerAdminGroupId:
      typeof raw.workerAdminGroupId === "string" ? raw.workerAdminGroupId.trim() : "",
    r2ItemWriteGroupId:
      typeof raw.r2ItemWriteGroupId === "string" ? raw.r2ItemWriteGroupId.trim() : "",
  };
}

export interface ConfigError {
  /** Machine-readable reason, safe to return to the agent. No secrets. */
  code:
    | "not_configured"
    | "project_not_allowed"
    | "concurrency_cap"
    | "not_assignee"
    | "ttl_too_long"
    | "issue_not_found"
    | "bad_prefix";
  message: string;
}

/**
 * Fail-closed gate for provisioning. Returns null when provisioning may
 * proceed. Missing minting credential, account, egress CIDRs,
 * permission-group ids or allow-list all block provisioning before any
 * Cloudflare call is made. `liveCount` covers every tracked env (live plus
 * in-progress provisioning), so repeated failed provisions can't bypass the
 * concurrency cap either.
 */
export function checkProvisionAllowed(
  config: CfTestEnvConfig,
  opts: { projectId: string; liveCount: number },
): ConfigError | null {
  if (!config.tokenSecretRef || !config.accountId || config.egressCidrs.length === 0) {
    return { code: "not_configured", message: "cf-test-env is not configured; cannot provision." };
  }
  if (!config.workerAdminGroupId || !config.r2ItemWriteGroupId) {
    return {
      code: "not_configured",
      message: "cf-test-env permission group ids are not configured; refusing to mint a token.",
    };
  }
  if (!isValidNamePrefix(config.namePrefix)) {
    return {
      code: "bad_prefix",
      message: `cf-test-env namePrefix ${JSON.stringify(config.namePrefix)} is invalid; refusing to provision.`,
    };
  }
  if (config.allowedProjectIds.length === 0 || !config.allowedProjectIds.includes(opts.projectId)) {
    return { code: "project_not_allowed", message: "This project is not allow-listed for cf-test-env." };
  }
  if (opts.liveCount >= config.maxConcurrentEnvs) {
    return {
      code: "concurrency_cap",
      message: `Too many live test envs (${opts.liveCount}/${config.maxConcurrentEnvs}); tear one down first.`,
    };
  }
  return null;
}
