import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { CfClient, type FetchImpl } from "./cloudflare.js";
import { checkProvisionAllowed, type CfTestEnvConfig } from "./config.js";
import { ENV_DOC_KEY } from "./manifest.js";
import {
  buildTokenPolicies,
  buildTokenRequest,
  clampTtl,
  R2_ITEM_WRITE_GROUP_NAME,
  WORKER_ADMIN_GROUP_NAME,
  workerNameFor,
} from "./scoping.js";

export interface EnvRecord {
  envId: string;
  issueId: string;
  companyId: string;
  projectId: string;
  workerName: string;
  workerId: string;
  d1Id: string;
  kvId: string;
  r2Bucket: string;
  tokenId: string;
  /** ISO expiry of the minted token. */
  expiresAt: string;
  createdAt: string;
  status: "live" | "torn_down";
}

export interface ProvisionResult {
  envId: string;
  workerName: string;
  accountId: string;
  expiresAt: string;
  /** Short-lived per-Worker token. Returned to the agent only, never persisted. */
  token: string;
}

const indexKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: "cf-test-env:index" });
const envKey = (companyId: string, envId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  stateKey: `cf-test-env:env:${envId}`,
});

async function readIndex(ctx: PluginContext, companyId: string): Promise<string[]> {
  const raw = (await ctx.state.get(indexKey(companyId))) as string[] | null;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

async function writeIndex(ctx: PluginContext, companyId: string, ids: string[]): Promise<void> {
  await ctx.state.set(indexKey(companyId), ids);
}

export async function readEnv(ctx: PluginContext, companyId: string, envId: string): Promise<EnvRecord | null> {
  if (!isSafeId(envId)) return null;
  const raw = (await ctx.state.get(envKey(companyId, envId))) as EnvRecord | null;
  if (!raw || typeof raw !== "object" || raw.status !== "live") return null;
  return raw;
}

const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);

export function randomHex(bytes: number): string {
  const chars: string[] = [];
  for (let i = 0; i < bytes; i++) {
    chars.push(Math.floor(Math.random() * 256).toString(16).padStart(2, "0"));
  }
  return chars.join("");
}

export interface ProvisionDeps {
  fetchImpl: FetchImpl;
  nowMs?: number;
  randHex?: string;
  resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string>;
}

/**
 * Provision a disposable test env for the caller's card.
 * Fail-closed: every check runs before the first Cloudflare call, and the
 * minted token value is returned to the agent only — never written to state,
 * documents, or logs.
 */
export async function provision(
  ctx: PluginContext,
  config: CfTestEnvConfig,
  run: ToolRunContext,
  input: { issueId: string; ttlSeconds?: number },
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const issue = await ctx.issues.get(input.issueId, run.companyId);
  if (!issue) {
    throw new Error("Issue not found.");
  }
  if (issue.assigneeAgentId !== run.agentId) {
    throw new Error("Only the agent assigned to the issue may provision its test env.");
  }
  const projectId = (issue as { projectId?: string }).projectId ?? run.projectId;
  const live = await liveEnvs(ctx, run.companyId);
  const gate = checkProvisionAllowed(config, { projectId, liveCount: live.length });
  if (gate) throw new Error(gate.message);
  const ttl = clampTtl(input.ttlSeconds, config.maxTtlSeconds);

  const mintToken = deps.resolveMintToken
    ? await deps.resolveMintToken(config.tokenSecretRef, run.companyId)
    : await ctx.secrets.resolve(config.tokenSecretRef!, { companyId: run.companyId });
  const cf = new CfClient(deps.fetchImpl, mintToken, config.accountId);

  const rand = deps.randHex ?? randomHex(3);
  const workerName = workerNameFor(config.namePrefix, input.issueId, rand);
  const envId = `${workerName}`;

  // Create resources first: the per-Worker token needs the Worker id.
  const worker = await cf.createWorkerScript(workerName);
  const d1 = await cf.createD1(workerName);
  const kv = await cf.createNamespace(workerName);
  await cf.createBucket(workerName);

  const workerAdminGroupId = await cf.resolvePermissionGroupId(
    WORKER_ADMIN_GROUP_NAME,
    config.workerAdminGroupId,
  );
  const r2ItemWriteGroupId = await cf.resolvePermissionGroupId(
    R2_ITEM_WRITE_GROUP_NAME,
    config.r2ItemWriteGroupId,
  );
  const policies = buildTokenPolicies({
    accountId: config.accountId,
    workerId: worker.id,
    bucketName: workerName,
    workerAdminGroupId,
    r2ItemWriteGroupId,
  });
  const tokenReq = buildTokenRequest({
    name: `${workerName}-token`,
    policies,
    nowMs,
    ttlSeconds: ttl,
    egressCidr: config.egressCidr,
  });
  const token = await cf.createAccountToken(tokenReq);

  const record: EnvRecord = {
    envId,
    issueId: input.issueId,
    companyId: run.companyId,
    projectId,
    workerName,
    workerId: worker.id,
    d1Id: d1.uuid,
    kvId: kv.id,
    r2Bucket: workerName,
    tokenId: token.id,
    expiresAt: tokenReq.expires_on,
    createdAt: new Date(nowMs).toISOString(),
    status: "live",
  };
  await ctx.state.set(envKey(run.companyId, envId), record);
  await writeIndex(ctx, run.companyId, [...(await readIndex(ctx, run.companyId)), envId]);

  // Non-secret record on the card: names and expiry only, never the token.
  await ctx.issues.documents.upsert({
    issueId: input.issueId,
    key: ENV_DOC_KEY,
    companyId: run.companyId,
    title: "Cloudflare test env",
    format: "markdown",
    body: [
      `# Cloudflare test env \`${workerName}\``,
      ``,
      `- worker: \`${workerName}\``,
      `- account: \`${config.accountId}\``,
      `- expires: \`${record.expiresAt}\``,
      `- d1: \`${d1.uuid}\` (via the \`d1_execute\` tool only)`,
      `- kv: \`${kv.id}\``,
      `- r2: \`${workerName}\``,
      ``,
      `Never use the root wrangler.jsonc.`,
    ].join("\n"),
  });

  return { envId, workerName, accountId: config.accountId, expiresAt: record.expiresAt, token: token.value };
}

/** Run SQL only on the env's own D1. The env token cannot do this; the worker can. */
export async function d1Execute(
  ctx: PluginContext,
  config: CfTestEnvConfig,
  run: ToolRunContext,
  input: { envId: string; sql: string; params?: unknown[] },
  deps: { fetchImpl: FetchImpl; resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string> },
): Promise<unknown> {
  const env = await readEnv(ctx, run.companyId, input.envId);
  if (!env) throw new Error("Test env not found or already torn down.");
  if (Date.parse(env.expiresAt) <= Date.now()) {
    throw new Error("Test env expired; provision a fresh one.");
  }
  if (!config.tokenSecretRef || !config.accountId) {
    throw new Error("cf-test-env is not configured; cannot run SQL.");
  }
  const mintToken = deps.resolveMintToken
    ? await deps.resolveMintToken(config.tokenSecretRef, run.companyId)
    : await ctx.secrets.resolve(config.tokenSecretRef, { companyId: run.companyId });
  const cf = new CfClient(deps.fetchImpl, mintToken, config.accountId);
  return cf.d1Query(env.d1Id, input.sql, input.params);
}

/**
 * Tear down an env: revoke the token FIRST (so a leaked token dies even if
 * resource deletion fails), then delete Worker, D1, KV and R2 (emptied
 * first), then drop state and update the card record.
 */
export async function teardown(
  ctx: PluginContext,
  config: CfTestEnvConfig,
  companyId: string,
  envId: string,
  deps: { fetchImpl: FetchImpl; resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string> },
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  const raw = (await ctx.state.get(envKey(companyId, envId))) as EnvRecord | null;
  if (!raw || raw.status !== "live") return { errors };
  if (!config.tokenSecretRef || !config.accountId) {
    return { errors: ["cf-test-env is not configured; cannot tear down. State kept for retry."] };
  }
  const mintToken = deps.resolveMintToken
    ? await deps.resolveMintToken(config.tokenSecretRef, companyId)
    : await ctx.secrets.resolve(config.tokenSecretRef, { companyId });
  const cf = new CfClient(deps.fetchImpl, mintToken, config.accountId);

  const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await attempt("revoke token", () => cf.revokeAccountToken(raw.tokenId));
  await attempt("delete worker", () => cf.deleteWorkerScript(raw.workerName));
  await attempt("delete d1", () => cf.deleteD1(raw.d1Id));
  await attempt("delete kv", () => cf.deleteNamespace(raw.kvId));
  await attempt("empty r2", async () => {
    const objects = await cf.listBucketObjects(raw.r2Bucket);
    await cf.deleteBucketObjects(raw.r2Bucket, objects.map((o) => o.key));
  });
  await attempt("delete r2 bucket", () => cf.deleteBucket(raw.r2Bucket));

  if (errors.length === 0) {
    await ctx.state.delete(envKey(companyId, envId));
    await writeIndex(
      ctx,
      companyId,
      (await readIndex(ctx, companyId)).filter((id) => id !== envId),
    );
    try {
      await ctx.issues.documents.upsert({
        issueId: raw.issueId,
        key: ENV_DOC_KEY,
        companyId,
        title: "Cloudflare test env",
        format: "markdown",
        body: `# Cloudflare test env \`${raw.workerName}\`\n\nTorn down at ${new Date().toISOString()}.`,
      });
    } catch {
      // Card bookkeeping must not fail the teardown.
    }
  }
  return { errors };
}

export async function liveEnvs(ctx: PluginContext, companyId: string): Promise<EnvRecord[]> {
  const ids = await readIndex(ctx, companyId);
  const out: EnvRecord[] = [];
  for (const id of ids) {
    const env = (await ctx.state.get(envKey(companyId, id))) as EnvRecord | null;
    if (env && env.status === "live") out.push(env);
  }
  return out;
}

export interface SweepResult {
  checked: number;
  tornDown: string[];
  errors: string[];
}

/**
 * Hourly sweep: tear down envs whose token expired, and envs whose owning
 * card is done/cancelled (or unreadable — orphaned). Only touches envs in
 * this plugin's state index, never arbitrary `pct-*` names.
 */
export async function sweep(
  ctx: PluginContext,
  config: CfTestEnvConfig,
  companyId: string,
  deps: { fetchImpl: FetchImpl; nowMs?: number; resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string> },
): Promise<SweepResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const result: SweepResult = { checked: 0, tornDown: [], errors: [] };
  for (const env of await liveEnvs(ctx, companyId)) {
    result.checked += 1;
    let stale = Date.parse(env.expiresAt) <= nowMs;
    if (!stale) {
      try {
        const issue = await ctx.issues.get(env.issueId, companyId);
        const status = (issue as { status?: string } | null)?.status;
        stale = !issue || status === "done" || status === "cancelled";
      } catch {
        stale = true; // Orphaned: owning card unreadable.
      }
    }
    if (!stale) continue;
    const { errors } = await teardown(ctx, config, companyId, env.envId, deps);
    if (errors.length === 0) {
      result.tornDown.push(env.envId);
    } else {
      result.errors.push(...errors.map((e) => `${env.envId}: ${e}`));
    }
  }
  return result;
}

/** `issue.updated` handler: tear down envs of cards that just closed. */
export async function handleIssueUpdated(
  ctx: PluginContext,
  config: CfTestEnvConfig,
  companyId: string,
  issueId: string,
  status: string,
  deps: { fetchImpl: FetchImpl; resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string> },
): Promise<void> {
  if (status !== "done" && status !== "cancelled") return;
  // Only touch envs that reference this exact issue id — never name-prefix scans.
  const ids = await readIndex(ctx, companyId);
  for (const id of ids) {
    const env = (await ctx.state.get(envKey(companyId, id))) as EnvRecord | null;
    if (env && env.status === "live" && env.issueId === issueId) {
      await teardown(ctx, config, companyId, id, deps);
    }
  }
}
