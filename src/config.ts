import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

export interface CfTestEnvConfig {
  /** Company secret binding for the minting credential. Null means unconfigured: fail closed. */
  tokenSecretRef: EnvSecretRefBinding | null;
  accountId: string;
  allowedProjectIds: string[];
  namePrefix: string;
  maxTtlSeconds: number;
  maxConcurrentEnvs: number;
  egressCidr: string;
  workerAdminGroupId: string;
  r2ItemWriteGroupId: string;
}

export const DEFAULT_NAME_PREFIX = "pct-";
export const DEFAULT_MAX_TTL_SECONDS = 10800; // 3 h
export const DEFAULT_MAX_CONCURRENT_ENVS = 10;

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
  return {
    tokenSecretRef: isSecretRefBinding(raw.tokenSecretRef) ? raw.tokenSecretRef : null,
    accountId: typeof raw.accountId === "string" ? raw.accountId.trim() : "",
    allowedProjectIds: stringArray(raw.allowedProjectIds),
    namePrefix: prefix,
    maxTtlSeconds: intOr(raw.maxTtlSeconds, DEFAULT_MAX_TTL_SECONDS),
    maxConcurrentEnvs: intOr(raw.maxConcurrentEnvs, DEFAULT_MAX_CONCURRENT_ENVS),
    egressCidr: typeof raw.egressCidr === "string" ? raw.egressCidr.trim() : "",
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
    | "issue_not_found";
  message: string;
}

/**
 * Fail-closed gate for provisioning. Returns null when provisioning may
 * proceed. Missing minting credential, account, egress CIDR or allow-list
 * all block provisioning before any Cloudflare call is made.
 */
export function checkProvisionAllowed(
  config: CfTestEnvConfig,
  opts: { projectId: string; liveCount: number },
): ConfigError | null {
  if (!config.tokenSecretRef || !config.accountId || !config.egressCidr) {
    return { code: "not_configured", message: "cf-test-env is not configured; cannot provision." };
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
