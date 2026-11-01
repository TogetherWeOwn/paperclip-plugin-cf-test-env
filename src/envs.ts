import { randomBytes } from "node:crypto";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { CfClient, isAuthenticationFailure, type FetchImpl } from "./cloudflare.js";
import { checkProvisionAllowed, type CfTestEnvConfig } from "./config.js";
import { ENV_DOC_KEY } from "./manifest.js";
import {
  assertMintedTokenMatches,
  buildTokenPolicies,
  buildTokenRequest,
  clampTtl,
  workerNameFor,
} from "./scoping.js";

export interface EnvRecord {
  envId: string;
  issueId: string;
  companyId: string;
  projectId: string;
  /**
   * Agent that provisioned the env; only it may use or tear it down.
   * Optional: records written before 0.1.1 lack it and fall back to the
   * current-assignee + allow-list checks in authorizeEnvCaller.
   */
  ownerAgentId?: string;
  workerName: string;
  workerId: string;
  d1Id: string;
  kvId: string;
  r2Bucket: string;
  tokenId: string;
  /** ISO expiry of the minted token. */
  expiresAt: string;
  createdAt: string;
  status: "live";
}

/**
 * Written BEFORE the first Cloudflare call and updated as each resource is
 * created, so a partial provision (crash or failure mid-way) is visible to
 * the sweeper instead of leaking untracked resources — possibly including a
 * live, unrecorded token. Resource ids stay optional until their step
 * succeeds.
 */
export interface ProvisioningRecord {
  envId: string;
  issueId: string;
  companyId: string;
  projectId: string;
  ownerAgentId?: string;
  workerName: string;
  workerId?: string;
  d1Id?: string;
  kvId?: string;
  r2Bucket?: string;
  tokenId?: string;
  expiresAt?: string;
  createdAt: string;
  status: "provisioning";
}

export type AnyEnvRecord = EnvRecord | ProvisioningRecord;

/** Provisioning records older than this are stale and swept. */
export const PROVISIONING_STALE_MS = 30 * 60 * 1000;

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

/**
 * Promise-chain mutex per company for the env index. Two provisions (or a
 * provision racing the hourly sweep or a teardown) that each do
 * read-modify-write can otherwise drop an envId from the index; the sweep and
 * `issue.updated` only walk the index, so that env's Worker, D1, KV and R2
 * would leak with no record, and the concurrency cap would undercount. Every
 * index change goes through `addToIndex`/`removeFromIndex` — an add or remove
 * inside the lock, never a write-back of a stale copy.
 */
const indexLocks = new Map<string, Promise<void>>();

async function withIndexLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const prev = indexLocks.get(companyId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Compare against the stored tail, not `turn`: the map holds
  // `prev.then(() => turn)` (a different promise object), so comparing with
  // `turn` never matched and idle company entries leaked forever.
  const tail = prev.then(() => turn);
  indexLocks.set(companyId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (indexLocks.get(companyId) === tail) indexLocks.delete(companyId);
  }
}

async function addToIndex(ctx: PluginContext, companyId: string, envId: string): Promise<void> {
  await withIndexLock(companyId, async () => {
    const ids = await readIndex(ctx, companyId);
    if (!ids.includes(envId)) {
      await writeIndex(ctx, companyId, [...ids, envId]);
    }
  });
}

async function removeFromIndex(ctx: PluginContext, companyId: string, envId: string): Promise<void> {
  await withIndexLock(companyId, async () => {
    const ids = await readIndex(ctx, companyId);
    if (ids.includes(envId)) {
      await writeIndex(ctx, companyId, ids.filter((id) => id !== envId));
    }
  });
}

export async function readEnv(ctx: PluginContext, companyId: string, envId: string): Promise<EnvRecord | null> {
  const raw = await readAnyEnv(ctx, companyId, envId);
  if (!raw || raw.status !== "live") return null;
  return raw;
}

async function readAnyEnv(
  ctx: PluginContext,
  companyId: string,
  envId: string,
): Promise<AnyEnvRecord | null> {
  if (!isSafeId(envId)) return null;
  const raw = (await ctx.state.get(envKey(companyId, envId))) as AnyEnvRecord | null;
  if (!raw || typeof raw !== "object" || (raw.status !== "live" && raw.status !== "provisioning")) {
    return null;
  }
  return raw;
}

const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);

export function randomHex(bytes: number): string {
  // Unpredictable suffixes: Math.random has ~24 bits of state and repeats
  // across runs, so it must not feed resource names.
  return randomBytes(bytes).toString("hex");
}

export interface ProvisionDeps {
  fetchImpl: FetchImpl;
  nowMs?: number;
  randHex?: string;
  resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string>;
}

/**
 * Provision a disposable test env for the caller's card.
 * Fail-closed: every check runs before the first Cloudflare call, a
 * `provisioning` record is written before the first Cloudflare call and
 * updated as each resource is created (so a partial provision rolls back
 * instead of leaking), and the minted token value is returned to the agent
 * only — never written to plugin state or issue documents (it does appear in
 * the run transcript, bounded by its TTL and IP filter).
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
  // No fallback to the run's project: a card with no project must not borrow
  // the run's allow-listed project. Fail closed.
  const projectId = (issue as { projectId?: string }).projectId;
  if (!projectId) {
    throw new Error("Issue has no project; cannot provision a test env.");
  }
  // Count every tracked env (live plus in-progress provisioning) so repeated
  // failed provisions can't bypass the concurrency cap.
  const tracked = await allEnvs(ctx, run.companyId);
  const gate = checkProvisionAllowed(config, { projectId, liveCount: tracked.length });
  if (gate) throw new Error(gate.message);
  const ttl = clampTtl(input.ttlSeconds, config.maxTtlSeconds);

  const mintToken = deps.resolveMintToken
    ? await deps.resolveMintToken(config.tokenSecretRef, run.companyId)
    : await ctx.secrets.resolve(config.tokenSecretRef!, { companyId: run.companyId });
  const cf = new CfClient(deps.fetchImpl, mintToken, config.accountId);

  const rand = deps.randHex ?? randomHex(3);
  const workerName = workerNameFor(config.namePrefix, input.issueId, rand);
  const envId = `${workerName}`;

  // Provisioning record first: any failure below rolls back against this, and
  // the sweep retries whatever rollback couldn't finish.
  const progress: ProvisioningRecord = {
    envId,
    issueId: input.issueId,
    companyId: run.companyId,
    projectId,
    ownerAgentId: run.agentId,
    workerName,
    createdAt: new Date(nowMs).toISOString(),
    status: "provisioning",
  };
  const saveProgress = async (): Promise<void> => {
    await ctx.state.set(envKey(run.companyId, envId), { ...progress });
  };
  await saveProgress();
  await addToIndex(ctx, run.companyId, envId);

  try {
    // Never overwrite a pre-existing Worker: the minted token would otherwise
    // get Admin over somebody else's script.
    const existing = await cf.getWorkerScript(workerName);
    if (existing) {
      throw new Error(`Worker ${workerName} already exists; refusing to overwrite it.`);
    }
    // Same for the R2 bucket: adopting a foreign bucket would let rollback
    // or teardown empty and delete somebody else's data.
    if ((await cf.listBuckets()).includes(workerName)) {
      throw new Error(`R2 bucket ${workerName} already exists; refusing to adopt it.`);
    }
    // Create resources first: the per-Worker token needs the Worker id.
    const worker = await cf.createWorkerScript(workerName);
    progress.workerId = worker.id;
    await saveProgress();
    const d1 = await cf.createD1(workerName);
    progress.d1Id = d1.uuid;
    await saveProgress();
    const kv = await cf.createNamespace(workerName);
    progress.kvId = kv.id;
    await saveProgress();
    await cf.createBucket(workerName);
    progress.r2Bucket = workerName;
    await saveProgress();

    // Permission-group ids are required config (fail-closed in the gate
    // above): no runtime lookup by display name.
    const policies = buildTokenPolicies({
      accountId: config.accountId,
      workerId: worker.id,
      bucketName: workerName,
      workerAdminGroupId: config.workerAdminGroupId,
      r2ItemWriteGroupId: config.r2ItemWriteGroupId,
    });
    const tokenReq = buildTokenRequest({
      name: `${workerName}-token`,
      policies,
      nowMs,
      ttlSeconds: ttl,
      egressCidrs: config.egressCidrs,
    });
    const token = await cf.createAccountToken(tokenReq);
    progress.tokenId = token.id;
    progress.expiresAt = tokenReq.expires_on;
    await saveProgress();
    // Fail closed on shape drift: verify the stored token carries the exact
    // egress CIDR, an expiry no later than requested, exactly 2 policies, and
    // exactly the resource keys built above. On mismatch the catch below
    // revokes the token (progress.tokenId is set) and rolls everything back.
    assertMintedTokenMatches(await cf.getAccountToken(token.id), {
      policies,
      expiresOn: tokenReq.expires_on,
      egressCidrs: config.egressCidrs,
    });

    const record: EnvRecord = {
      envId,
      issueId: input.issueId,
      companyId: run.companyId,
      projectId,
      ownerAgentId: run.agentId,
      workerName,
      workerId: worker.id,
      d1Id: d1.uuid,
      kvId: kv.id,
      r2Bucket: workerName,
      tokenId: token.id,
      expiresAt: tokenReq.expires_on,
      createdAt: progress.createdAt,
      status: "live",
    };
    await ctx.state.set(envKey(run.companyId, envId), record);

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
  } catch (err) {
    // Roll back in teardown order — revoke the token first — then rethrow.
    // When rollback is clean there is nothing for the sweep to do, so the
    // provisioning record is dropped; otherwise it is kept for the sweep.
    //
    // If provisioning itself died with a 401, the credential or IP filter is
    // dead and every rollback call would 401 too (same credential, same host,
    // same filter), so no rollback call is attempted — one deterministic
    // failure must not become several. The kept record lets the hourly sweep
    // retry once the operator fixes the credential or filter.
    const rollbackErrors = isAuthenticationFailure(err)
      ? ["rollback skipped after an authentication failure; resources kept for the sweep"]
      : await rollbackPartial(cf, progress);
    if (rollbackErrors.length === 0) {
      await ctx.state.delete(envKey(run.companyId, envId));
      await removeFromIndex(ctx, run.companyId, envId);
    } else {
      await saveProgress();
    }
    const detail = rollbackErrors.length > 0 ? ` (rollback incomplete: ${rollbackErrors.join("; ")})` : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}${detail}`);
  }
}

/**
 * Best-effort rollback of a partial provision, in teardown order. Returns the
 * step errors (empty when everything was undone). Aborts the remaining steps
 * on the first 401: every further call would fail the same way, and
 * Cloudflare locks the caller out after repeated authentication failures.
 * A 403 is recorded as an ordinary step error and the remaining steps still
 * run — it is resource-specific, not a dead credential.
 */
async function rollbackPartial(cf: CfClient, progress: ProvisioningRecord): Promise<string[]> {
  const errors: string[] = [];
  let authFailed = false;
  const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    if (authFailed) return;
    try {
      await fn();
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      if (isAuthenticationFailure(err)) authFailed = true;
    }
  };
  if (progress.tokenId) {
    await attempt("revoke token", () => cf.revokeAccountToken(progress.tokenId!));
  }
  // Only delete a Worker this provision created (create returned an id).
  // In particular, never delete the pre-existing Worker that trips the
  // overwrite guard above. Residual risk: a PUT that succeeded remotely with
  // a lost response leaks one untracked Worker — accepted over deleting
  // foreign Workers.
  if (progress.workerId) {
    await attempt("delete worker", () => cf.deleteWorkerScript(progress.workerName));
  }
  if (progress.d1Id) {
    await attempt("delete d1", () => cf.deleteD1(progress.d1Id!));
  }
  if (progress.kvId) {
    await attempt("delete kv", () => cf.deleteNamespace(progress.kvId!));
  }
  if (progress.r2Bucket) {
    await attempt("empty r2", () => emptyBucket(cf, progress.r2Bucket!));
    await attempt("delete r2 bucket", () => cf.deleteBucket(progress.r2Bucket!));
  }
  return errors;
}

/**
 * Same gate as provision: the caller must be the agent that provisioned the
 * env (and still be the card's assignee), and the env's project must still be
 * allow-listed. Without this, any agent in the company could run arbitrary
 * SQL on another card's D1 (the envId is the Worker name, which the card
 * document publishes) with the near-admin minting credential.
 */
export async function authorizeEnvCaller(
  ctx: PluginContext,
  config: CfTestEnvConfig,
  run: { agentId: string; companyId: string },
  env: AnyEnvRecord,
): Promise<void> {
  // Records written before 0.1.1 have no ownerAgentId; they fall back to the
  // current-assignee + allow-list checks below.
  if (env.ownerAgentId && run.agentId !== env.ownerAgentId) {
    throw new Error("Only the agent that provisioned this test env may use it.");
  }
  const issue = await ctx.issues.get(env.issueId, run.companyId);
  if (!issue || (issue as { assigneeAgentId?: string }).assigneeAgentId !== run.agentId) {
    throw new Error("Only the agent assigned to the issue may use its test env.");
  }
  // The card's CURRENT project must be allow-listed: moving the card to a
  // disallowed project revokes D1/teardown access instead of grandfathering it.
  const currentProjectId = (issue as { projectId?: string }).projectId;
  if (!currentProjectId || !config.allowedProjectIds.includes(currentProjectId)) {
    throw new Error("This project is not allow-listed for cf-test-env.");
  }
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
  await authorizeEnvCaller(ctx, config, run, env);
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
 * Empty an R2 bucket. Each round snapshots the full key listing (following
 * cursors — a single 1000-object page is not enough) BEFORE deleting
 * anything: deleting between pages shifts offset-based listings and would
 * silently skip objects, and leftover objects block the bucket delete and
 * wedge the env in state. Rounds repeat so objects added concurrently still
 * converge; a bucket that never empties fails loudly and keeps state.
 */
export async function emptyBucket(cf: CfClient, bucket: string): Promise<void> {
  // No retries here: any Cloudflare error (in particular a 401
  // authentication failure) propagates immediately instead of looping. The
  // round loop below only repeats after a fully successful snapshot-and-delete
  // pass that still finds objects (concurrent adds) — it never retries a
  // failed call.
  for (let round = 0; round < 10; round++) {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await cf.listBucketObjects(bucket, cursor);
      keys.push(...page.objects.map((o) => o.key));
      if (!page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
    if (keys.length === 0) return;
    for (const key of keys) {
      await cf.deleteBucketObject(bucket, key);
    }
  }
  throw new Error(`bucket ${bucket} still has objects after emptying; keeping state for retry`);
}

/**
 * Tear down an env: revoke the token FIRST (so a leaked token dies even if
 * resource deletion fails), then delete Worker, D1, KV and R2 (emptied
 * first), then drop state and update the card record.
 *
 * Handles both live envs and stale `provisioning` records (deleting only the
 * resources the record shows as created). 404 on any DELETE counts as
 * success, so retries can't wedge an env in state forever.
 *
 * When `run` is provided (an agent calling the `teardown` tool), the same
 * gate as provision applies. System paths (sweep, issue.updated, provision
 * rollback) omit it.
 */
export async function teardown(
  ctx: PluginContext,
  config: CfTestEnvConfig,
  companyId: string,
  envId: string,
  deps: { fetchImpl: FetchImpl; resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string> },
  run?: { agentId: string },
): Promise<{ errors: string[]; authFailed: boolean }> {
  const errors: string[] = [];
  const raw = await readAnyEnv(ctx, companyId, envId);
  if (!raw) return { errors, authFailed: false };
  // Set on the first 401: every further Cloudflare call would fail the same
  // way, and Cloudflare locks the caller out after repeated authentication
  // failures — so the steps below stop instead of looping. A 403 is recorded
  // as an ordinary step error and the remaining steps still run.
  let authFailed = false;
  if (run) {
    await authorizeEnvCaller(ctx, config, { agentId: run.agentId, companyId }, raw);
  }
  if (!config.tokenSecretRef || !config.accountId) {
    return { errors: ["cf-test-env is not configured; cannot tear down. State kept for retry."], authFailed };
  }
  const mintToken = deps.resolveMintToken
    ? await deps.resolveMintToken(config.tokenSecretRef, companyId)
    : await ctx.secrets.resolve(config.tokenSecretRef, { companyId });
  const cf = new CfClient(deps.fetchImpl, mintToken, config.accountId);

  const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    if (authFailed) return;
    try {
      await fn();
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      if (isAuthenticationFailure(err)) authFailed = true;
    }
  };

  if (raw.tokenId) {
    await attempt("revoke token", () => cf.revokeAccountToken(raw.tokenId!));
  }
  // Live records always carry workerId; provisioning records only when this
  // provision created the Worker — a swept pre-check record must never delete
  // a foreign Worker that happens to share the name.
  if (raw.status === "live" || raw.workerId) {
    await attempt("delete worker", () => cf.deleteWorkerScript(raw.workerName));
  }
  if (raw.d1Id) {
    const d1Id = raw.d1Id;
    await attempt("delete d1", () => cf.deleteD1(d1Id));
  }
  if (raw.kvId) {
    const kvId = raw.kvId;
    await attempt("delete kv", () => cf.deleteNamespace(kvId));
  }
  if (raw.r2Bucket) {
    const bucket = raw.r2Bucket;
    await attempt("empty r2", () => emptyBucket(cf, bucket));
    await attempt("delete r2 bucket", () => cf.deleteBucket(bucket));
  }

  if (errors.length === 0) {
    await ctx.state.delete(envKey(companyId, envId));
    await removeFromIndex(ctx, companyId, envId);
    if (raw.status === "live") {
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
  }
  return { errors, authFailed };
}

export async function liveEnvs(ctx: PluginContext, companyId: string): Promise<EnvRecord[]> {
  return (await allEnvs(ctx, companyId)).filter((e): e is EnvRecord => e.status === "live");
}

/** Every tracked env: live plus in-progress provisioning. */
export async function allEnvs(ctx: PluginContext, companyId: string): Promise<AnyEnvRecord[]> {
  const ids = await readIndex(ctx, companyId);
  const out: AnyEnvRecord[] = [];
  for (const id of ids) {
    const env = await readAnyEnv(ctx, companyId, id);
    if (env) out.push(env);
  }
  return out;
}

export interface SweepResult {
  checked: number;
  tornDown: string[];
  errors: string[];
}

/**
 * Hourly sweep: tear down live envs whose token expired, live envs whose
 * owning card is done/cancelled (or unreadable — orphaned), and stale
 * `provisioning` records left by a crashed or incompletely rolled-back
 * provision. Only touches envs in this plugin's state index, never
 * arbitrary `pct-*` names.
 */
export async function sweep(
  ctx: PluginContext,
  config: CfTestEnvConfig,
  companyId: string,
  deps: { fetchImpl: FetchImpl; nowMs?: number; resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string> },
): Promise<SweepResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const result: SweepResult = { checked: 0, tornDown: [], errors: [] };
  for (const env of await allEnvs(ctx, companyId)) {
    result.checked += 1;
    let stale: boolean;
    if (env.status === "provisioning") {
      stale = nowMs - Date.parse(env.createdAt) > PROVISIONING_STALE_MS;
    } else if (Date.parse(env.expiresAt) <= nowMs) {
      stale = true;
    } else {
      try {
        const issue = await ctx.issues.get(env.issueId, companyId);
        const status = (issue as { status?: string } | null)?.status;
        stale = !issue || status === "done" || status === "cancelled";
      } catch {
        stale = true; // Orphaned: owning card unreadable.
      }
    }
    if (!stale) continue;
    const { errors, authFailed } = await teardown(ctx, config, companyId, env.envId, deps);
    if (errors.length === 0) {
      result.tornDown.push(env.envId);
    } else {
      result.errors.push(...errors.map((e) => `${env.envId}: ${e}`));
    }
    // The minting credential (or its IP filter) is broken: every further env
    // would fail the same way, so stop the sweep instead of stacking 401s.
    if (authFailed) break;
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
  deps: {
    fetchImpl: FetchImpl;
    nowMs?: number;
    resolveMintToken?: (secretRef: unknown, companyId: string) => Promise<string>;
  },
): Promise<void> {
  if (status !== "done" && status !== "cancelled") return;
  const nowMs = deps.nowMs ?? Date.now();
  // Only touch envs that reference this exact issue id — never name-prefix scans.
  for (const env of await allEnvs(ctx, companyId)) {
    if (env.issueId !== issueId) continue;
    // Never pull the index out from under a still-running provision: a
    // `provisioning` record younger than the sweep's stale window is left for
    // the sweep (which only tears down stale provisioning records). The
    // just-closed card still loses its env — once the run finishes, the env is
    // either rolled back or `live` on a closed card, and the next sweep tears
    // it down. Nothing leaks; the token still expires within 3 h regardless.
    if (env.status === "provisioning" && nowMs - Date.parse(env.createdAt) <= PROVISIONING_STALE_MS) {
      continue;
    }
    // One broken credential must not stack a 401 per env on the same card.
    const { authFailed } = await teardown(ctx, config, companyId, env.envId, deps);
    if (authFailed) break;
  }
}
