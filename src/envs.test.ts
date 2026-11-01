import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import { resolveConfig } from "./config.js";
import { allEnvs, d1Execute, handleIssueUpdated, liveEnvs, provision, sweep, teardown } from "./envs.js";
import { R2_BUCKET_RESOURCE, WORKER_SCRIPT_RESOURCE, workerNameFor } from "./scoping.js";
import { FakeCf } from "./test-support/fake-cf.js";

const COMPANY = "c-1";
const AGENT = "agent-1";
const OTHER = "agent-2";
const PROJ = "proj-kofra";

const baseConfig = {
  tokenSecretRef: { type: "secret_ref", secretId: "s-1" },
  accountId: "acct-1",
  allowedProjectIds: [PROJ],
  egressCidrs: ["203.0.113.10/32", "2001:db8:8:cb76::/64"],
  workerAdminGroupId: "grp-worker-admin",
  r2ItemWriteGroupId: "grp-r2-item-write",
};

const NOW = Date.parse("2026-11-01T19:30:00.000Z");

async function setup(configExtra: Record<string, unknown> = {}) {
  // Widen capabilities for test setup only (issue create/update, doc reads);
  // the shipped manifest stays minimal (see plugin.test.ts contract test).
  const harness = createTestHarness({
    manifest,
    config: { ...baseConfig, ...configExtra },
    capabilities: [...manifest.capabilities, "issues.create", "issues.update", "issue.documents.read"],
  });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  const issue = await harness.ctx.issues.create({
    companyId: COMPANY,
    title: "card",
    projectId: PROJ,
    assigneeAgentId: AGENT,
  });
  const fake = new FakeCf();
  const deps = {
    fetchImpl: fake.fetch,
    nowMs: NOW,
    randHex: "abc123",
    resolveMintToken: async () => "mint-token",
  };
  const run = { agentId: AGENT, runId: "run-1", companyId: COMPANY, projectId: PROJ };
  return { harness, fake, deps, run, issue };
}

describe("provision", () => {
  it("creates scoped resources and a scoped token, and records no secret", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const result = await provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps);
    expect(result.workerName.startsWith("pct-")).toBe(true);
    expect(result.token).toMatch(/^secret-value-/);
    // Token policies reference only the new worker and bucket, with the
    // exact documented resource shapes.
    const tokenCalls = fake.calls.filter((c) => c.path.endsWith("/tokens") && c.method === "POST");
    expect(tokenCalls).toHaveLength(1);
    const policies = (tokenCalls[0]!.body as { policies: unknown[] }).policies;
    expect(policies).toEqual([
      {
        effect: "allow",
        resources: { [`${WORKER_SCRIPT_RESOURCE}.wid-${result.workerName}`]: "*" },
        permission_groups: [{ id: "grp-worker-admin" }],
      },
      {
        effect: "allow",
        resources: { [`${R2_BUCKET_RESOURCE}.acct-1_default_${result.workerName}`]: "*" },
        permission_groups: [{ id: "grp-r2-item-write" }],
      },
    ]);
    const serialized = JSON.stringify(policies);
    for (const other of ["prod-worker-alpha", "prod-worker-beta", "shared-bucket"]) {
      expect(serialized).not.toContain(other);
    }
    // IP filter (dotted key, both families) and expiry (no milliseconds) are set.
    const tokenBody = tokenCalls[0]!.body as { condition: unknown; expires_on: string };
    expect(tokenBody.condition).toEqual({
      "request.ip": { in: ["203.0.113.10/32", "2001:db8:8:cb76::/64"] },
    });
    expect(tokenBody.expires_on).toBe("2026-11-01T22:30:00Z");
    // Card record holds names only — never the token.
    const doc = await harness.ctx.issues.documents.get(issue.id, "cf-test-env", COMPANY);
    expect(doc?.body).toContain(result.workerName);
    expect(doc?.body).not.toContain(result.token);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(1);
  });

  it("rejects callers that are not the assignee", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), { ...run, agentId: OTHER }, { issueId: issue.id }, deps),
    ).rejects.toThrow(/assigned/);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects issues with no project instead of borrowing the run's", async () => {
    const { harness, fake, deps, run } = await setup();
    const bare = await harness.ctx.issues.create({ companyId: COMPANY, title: "bare", assigneeAgentId: AGENT });
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: bare.id }, deps),
    ).rejects.toThrow(/no project/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses to overwrite a pre-existing Worker and leaves it intact", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const name = workerNameFor("pct-", issue.id, "abc123");
    await fake.fetch(`https://api.cloudflare.com/client/v4/accounts/acct-1/workers/scripts/${name}`, {
      method: "PUT",
      body: JSON.stringify({ script: "someone else's worker" }),
    });
    fake.calls.length = 0;
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps),
    ).rejects.toThrow(/already exists/);
    // The rollback must not delete the Worker it refused to overwrite.
    expect(fake.scripts.has(name)).toBe(true);
    expect([...fake.tokens.keys()]).toHaveLength(0);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(0);
    expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(0);
  });

  it("refuses to adopt a pre-existing R2 bucket and leaves its data intact", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const name = workerNameFor("pct-", issue.id, "abc123");
    await fake.fetch(`https://api.cloudflare.com/client/v4/accounts/acct-1/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    fake.buckets.get(name)!.objects.push("precious");
    fake.calls.length = 0;
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps),
    ).rejects.toThrow(/bucket.*already exists/);
    expect(fake.buckets.get(name)?.objects).toEqual(["precious"]);
    expect([...fake.tokens.keys()]).toHaveLength(0);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(0);
    expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(0);
  });

  it("rejects non-allow-listed projects and full caps without Cloudflare calls", async () => {
    const { harness, fake, deps, run, issue } = await setup({ maxConcurrentEnvs: 1 });
    const config = resolveConfig({ ...baseConfig, maxConcurrentEnvs: 1 });
    await provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...deps, randHex: "aaaaaa" });
    await expect(
      provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...deps, randHex: "bbbbbb" }),
    ).rejects.toThrow(/Too many live/);
    const other = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "other",
      projectId: "proj-other",
      assigneeAgentId: AGENT,
    });
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig, allowedProjectIds: ["proj-else"] }), run, { issueId: other.id }, deps),
    ).rejects.toThrow(/allow-list/);
    expect(fake.calls.filter((c) => c.path.endsWith("/tokens"))).toHaveLength(1);
  });

  it("fails closed when unconfigured, unscoped, badly prefixed or when the TTL is too long", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig, tokenSecretRef: null }), run, { issueId: issue.id }, deps),
    ).rejects.toThrow(/not configured/);
    await expect(
      provision(
        ctxOf(harness),
        resolveConfig({ ...baseConfig, workerAdminGroupId: "", r2ItemWriteGroupId: "" }),
        run,
        { issueId: issue.id },
        deps,
      ),
    ).rejects.toThrow(/permission group/);
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig, namePrefix: "prod-app-" }), run, { issueId: issue.id }, deps),
    ).rejects.toThrow(/invalid/);
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id, ttlSeconds: 99999 }, deps),
    ).rejects.toThrow(/exceeds/);
    expect(fake.calls).toHaveLength(0);
  });

  it("rolls back a partial provision without leaking resources", async () => {
    for (const failRule of [
      "PUT /accounts/acct-1/workers/scripts",
      "POST /accounts/acct-1/d1/database",
      "POST /accounts/acct-1/storage/kv/namespaces",
      "POST /accounts/acct-1/r2/buckets",
      "POST /accounts/acct-1/tokens",
    ]) {
      const { harness, fake, deps, run, issue } = await setup();
      fake.failOn = [failRule];
      await expect(
        provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps),
      ).rejects.toThrow(/(injected failure|rollback)/);
      expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(0);
      expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(0);
      expect(fake.scripts.size).toBe(0);
      expect(fake.dbs.size).toBe(0);
      expect(fake.namespaces.size).toBe(0);
      expect(fake.buckets.size).toBe(0);
      expect([...fake.tokens.values()]).toHaveLength(0);
    }
  });

  it("skips rollback calls when provisioning itself dies with a 401", async () => {
    // Same credential, same host, same filter: every rollback call would 401
    // too, so none is attempted — one deterministic failure must not become
    // several. The record is kept for the hourly sweep.
    const { harness, fake, deps, run, issue } = await setup();
    fake.failWithAuthOn = ["POST /accounts/acct-1/d1/database"];
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps),
    ).rejects.toThrow(/rollback skipped/);
    // The Worker created before the 401 is recorded but untouched: no DELETE
    // was attempted, and the provisioning record stays for the sweep.
    expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(fake.scripts.size).toBe(1);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(0);
    expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(1);
  });

  it("revokes a minted token when a later step fails", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const upsert = harness.ctx.issues.documents.upsert.bind(harness.ctx.issues.documents);
    harness.ctx.issues.documents.upsert = async () => {
      throw new Error("doc store down");
    };
    try {
      await expect(
        provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps),
      ).rejects.toThrow(/doc store down/);
    } finally {
      harness.ctx.issues.documents.upsert = upsert;
    }
    // Token was minted then revoked; nothing leaks; no record is kept.
    expect(fake.revokedTokens).toHaveLength(1);
    expect([...fake.tokens.values()]).toHaveLength(0);
    expect(fake.scripts.size).toBe(0);
    expect(fake.dbs.size).toBe(0);
    expect(fake.namespaces.size).toBe(0);
    expect(fake.buckets.size).toBe(0);
    expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(0);
  });

  it("revokes the minted token and fails closed when verification fails", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    // The API silently drops the condition: the read-back token has no IP
    // filter, so provision must revoke it and throw without returning a value.
    fake.dropTokenConditionOnRead = true;
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps),
    ).rejects.toThrow(/verification/);
    expect(fake.calls.some((c) => c.method === "GET" && /\/tokens\//.test(c.path))).toBe(true);
    expect(fake.revokedTokens).toHaveLength(1);
    expect([...fake.tokens.values()]).toHaveLength(0);
    expect(fake.scripts.size).toBe(0);
    expect(fake.dbs.size).toBe(0);
    expect(fake.namespaces.size).toBe(0);
    expect(fake.buckets.size).toBe(0);
    expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(0);
  });

  it("revokes the minted token and fails closed when the stored policy is broader", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    // The API stores broader grants than requested: same policy count, but a
    // widened (whole-account) resource value on one policy and a different
    // permission group on the other. The key-only check of round 2 would have
    // passed the first; the whole-policy check must reject both.
    fake.mutateTokenOnRead = (body) => {
      const policies = (body.policies as Array<Record<string, unknown>>).map((p, i) =>
        i === 0
          ? { ...p, resources: { "com.cloudflare.api.account.acct-1": "*" } }
          : { ...p, permission_groups: [{ id: "grp-something-broader" }] },
      );
      return { ...body, policies };
    };
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps),
    ).rejects.toThrow(/policies differ/);
    // The token is revoked, no value ever reaches the caller, nothing leaks,
    // and no record is kept.
    expect(fake.revokedTokens).toHaveLength(1);
    expect([...fake.tokens.values()]).toHaveLength(0);
    expect(fake.scripts.size).toBe(0);
    expect(fake.dbs.size).toBe(0);
    expect(fake.namespaces.size).toBe(0);
    expect(fake.buckets.size).toBe(0);
    expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(0);
  });

  it("keeps parallel provisions from dropping index entries", async () => {
    const { harness, deps, run, issue } = await setup();
    const other = await harness.ctx.issues.create({
      companyId: COMPANY,
      title: "other",
      projectId: PROJ,
      assigneeAgentId: AGENT,
    });
    const config = resolveConfig({ ...baseConfig });
    const [a, b] = await Promise.all([
      provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...deps, randHex: "aaaaaa" }),
      provision(ctxOf(harness), config, run, { issueId: other.id }, { ...deps, randHex: "bbbbbb" }),
    ]);
    expect(a.envId).not.toBe(b.envId);
    const tracked = await allEnvs(harness.ctx, COMPANY);
    expect(tracked.map((e) => e.envId).sort()).toEqual([a.envId, b.envId].sort());
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(2);
  });

  it("keeps the provisioning record when rollback itself fails, for the sweep", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    fake.failOn = ["POST /accounts/acct-1/tokens", "DELETE"];
    await expect(
      provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps),
    ).rejects.toThrow(/rollback incomplete/);
    const tracked = await allEnvs(harness.ctx, COMPANY);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.status).toBe("provisioning");
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(0);
    // The hourly sweep retries the stale record and finishes the rollback.
    fake.failOn = [];
    const result = await sweep(ctxOf(harness), resolveConfig({ ...baseConfig }), COMPANY, {
      ...deps,
      nowMs: NOW + 31 * 60 * 1000,
    });
    expect(result.tornDown).toHaveLength(1);
    expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(0);
  });
});

describe("d1_execute", () => {
  it("runs SQL only on the env's D1", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const provisioned = await provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps);
    await d1Execute(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { envId: provisioned.envId, sql: "select 1" }, deps);
    expect(fake.d1Queries).toHaveLength(1);
    const record = (await liveEnvs(harness.ctx, COMPANY))[0]!;
    expect(fake.d1Queries[0]!.databaseId).toBe(record.d1Id);
  });

  it("rejects unknown and expired envs", async () => {
    const { harness, deps, run } = await setup();
    await expect(
      d1Execute(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { envId: "pct-nope-000000", sql: "select 1" }, deps),
    ).rejects.toThrow(/not found/);
    const oldIssue = await harness.ctx.issues.create({ companyId: COMPANY, title: "old", projectId: PROJ, assigneeAgentId: AGENT });
    const oldDeps = { ...deps, nowMs: Date.now() - 20000 * 1000, randHex: "cccccc" };
    const provisioned = await provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: oldIssue.id }, oldDeps);
    await expect(
      d1Execute(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { envId: provisioned.envId, sql: "select 1" }, deps),
    ).rejects.toThrow(/expired/);
  });

  it("rejects callers that did not provision the env", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const provisioned = await provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps);
    await expect(
      d1Execute(
        ctxOf(harness),
        resolveConfig({ ...baseConfig }),
        { ...run, agentId: OTHER },
        { envId: provisioned.envId, sql: "select 1" },
        deps,
      ),
    ).rejects.toThrow(/provisioned/);
    expect(fake.d1Queries).toHaveLength(0);
  });

  it("rejects callers reassigned off the card or off the allow-list", async () => {
    const { harness, deps, run, issue } = await setup();
    const provisioned = await provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps);
    await harness.ctx.issues.update(issue.id, { assigneeAgentId: OTHER } as never, COMPANY);
    await expect(
      d1Execute(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { envId: provisioned.envId, sql: "select 1" }, deps),
    ).rejects.toThrow(/assigned/);
    await harness.ctx.issues.update(issue.id, { assigneeAgentId: AGENT } as never, COMPANY);
    await expect(
      d1Execute(
        ctxOf(harness),
        resolveConfig({ ...baseConfig, allowedProjectIds: ["proj-else"] }),
        run,
        { envId: provisioned.envId, sql: "select 1" },
        deps,
      ),
    ).rejects.toThrow(/allow-list/);
  });

  it("revokes access when the card moves to a disallowed project", async () => {
    const { harness, deps, run, issue } = await setup();
    const provisioned = await provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps);
    await harness.ctx.issues.update(issue.id, { projectId: "proj-other" } as never, COMPANY);
    await expect(
      d1Execute(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { envId: provisioned.envId, sql: "select 1" }, deps),
    ).rejects.toThrow(/allow-list/);
  });

  it("tolerates records written before ownerAgentId existed", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const provisioned = await provision(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { issueId: issue.id }, deps);
    const stored = (await liveEnvs(harness.ctx, COMPANY))[0]!;
    const { ownerAgentId: _dropped, ...legacy } = stored;
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: `cf-test-env:env:${stored.envId}` },
      { ...legacy },
    );
    // The assignee on an allow-listed project still works; anyone else doesn't.
    await d1Execute(ctxOf(harness), resolveConfig({ ...baseConfig }), run, { envId: provisioned.envId, sql: "select 1" }, deps);
    expect(fake.d1Queries).toHaveLength(1);
    await expect(
      d1Execute(
        ctxOf(harness),
        resolveConfig({ ...baseConfig }),
        { ...run, agentId: OTHER },
        { envId: provisioned.envId, sql: "select 1" },
        deps,
      ),
    ).rejects.toThrow(/assigned/);
  });
});

describe("teardown", () => {
  it("revokes the token first, then deletes everything and drops state", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const provisioned = await provision(ctxOf(harness), config, run, { issueId: issue.id }, deps);
    const { errors } = await teardown(ctxOf(harness), config, COMPANY, provisioned.envId, deps);
    expect(errors).toEqual([]);
    const revokeIdx = fake.calls.findIndex((c) => c.method === "DELETE" && /\/tokens\//.test(c.path));
    const deleteWorkerIdx = fake.calls.findIndex((c) => c.method === "DELETE" && /\/workers\/scripts\//.test(c.path));
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(deleteWorkerIdx).toBeGreaterThan(revokeIdx);
    expect(fake.scripts.size).toBe(0);
    expect(fake.dbs.size).toBe(0);
    expect(fake.namespaces.size).toBe(0);
    expect(fake.buckets.size).toBe(0);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(0);
    // Second teardown is a no-op.
    expect((await teardown(ctxOf(harness), config, COMPANY, provisioned.envId, deps)).errors).toEqual([]);
  });

  it("rejects agent callers that did not provision the env", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const provisioned = await provision(ctxOf(harness), config, run, { issueId: issue.id }, deps);
    const callsBefore = fake.calls.length;
    await expect(
      teardown(ctxOf(harness), config, COMPANY, provisioned.envId, deps, { agentId: OTHER }),
    ).rejects.toThrow(/provisioned/);
    expect(fake.calls.length).toBe(callsBefore);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(1);
    // The owner can still tear it down.
    expect((await teardown(ctxOf(harness), config, COMPANY, provisioned.envId, deps, { agentId: AGENT })).errors).toEqual([]);
  });

  it("treats already-deleted resources as success", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const provisioned = await provision(ctxOf(harness), config, run, { issueId: issue.id }, deps);
    // Simulate an earlier partial teardown outside the plugin.
    fake.scripts.clear();
    fake.dbs.clear();
    fake.namespaces.clear();
    fake.buckets.clear();
    fake.tokens.clear();
    const { errors } = await teardown(ctxOf(harness), config, COMPANY, provisioned.envId, deps);
    expect(errors).toEqual([]);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(0);
  });

  it("stops after the first auth failure instead of stacking 401s", async () => {
    // A dead minting credential (or an IP filter that doesn't cover the
    // caller) 401s every call; Cloudflare locks the caller out after repeated
    // authentication failures, so teardown must abort, not loop.
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const provisioned = await provision(ctxOf(harness), config, run, { issueId: issue.id }, deps);
    const callsBefore = fake.calls.length;
    fake.failWithAuthOn = ["DELETE"];
    const { errors, authFailed } = await teardown(ctxOf(harness), config, COMPANY, provisioned.envId, deps);
    expect(authFailed).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(fake.calls.length - callsBefore).toBe(1);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(1);
  });

  it("records a 403 but continues the remaining cleanup instead of aborting", async () => {
    // A 403 is resource-specific, not a dead credential: the remaining steps
    // still run, and the sweep must not treat it as fatal.
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const provisioned = await provision(ctxOf(harness), config, run, { issueId: issue.id }, deps);
    fake.failWithForbiddenOn = ["DELETE /accounts/acct-1/d1/database"];
    const { errors, authFailed } = await teardown(ctxOf(harness), config, COMPANY, provisioned.envId, deps);
    expect(authFailed).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("delete d1");
    // Cleanup continued past the forbidden D1: Worker, KV and R2 are gone.
    expect(fake.scripts.has(provisioned.workerName)).toBe(false);
    expect(fake.namespaces.size).toBe(0);
    expect(fake.buckets.has(provisioned.workerName)).toBe(false);
    // The error keeps the record for retry.
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(1);
  });

  it("empties multi-page buckets with per-object deletes", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const provisioned = await provision(ctxOf(harness), config, run, { issueId: issue.id }, deps);
    fake.buckets.set(provisioned.workerName, {
      objects: Array.from({ length: 2500 }, (_, i) => `k-${i}`),
    });
    const { errors } = await teardown(ctxOf(harness), config, COMPANY, provisioned.envId, deps);
    expect(errors).toEqual([]);
    expect(fake.buckets.has(provisioned.workerName)).toBe(false);
    const objectDeletes = fake.calls.filter((c) => c.method === "DELETE" && /\/objects\//.test(c.path));
    expect(objectDeletes.length).toBeGreaterThanOrEqual(2500);
  });
});

describe("sweep and issue.updated", () => {
  it("tears down expired envs and keeps live ones", async () => {
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const expired = await provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...deps, nowMs: NOW - 5 * 3600 * 1000, randHex: "dddddd" });
    const live = await provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...deps, randHex: "eeeeee" });
    const result = await sweep(ctxOf(harness), config, COMPANY, { ...deps, nowMs: NOW });
    expect(result.tornDown).toEqual([expired.envId]);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(1);
    expect((await liveEnvs(harness.ctx, COMPANY))[0]!.envId).toBe(live.envId);
    expect(fake.scripts.has(live.workerName)).toBe(true);
  });

  it("stops the sweep on the first auth failure", async () => {
    // With a dead credential every env would 401 the same way; the sweep
    // must stop after the first instead of stacking one 401 per env.
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const old = { ...deps, nowMs: NOW - 5 * 3600 * 1000 };
    const first = await provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...old, randHex: "111111" });
    const second = await provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...old, randHex: "222222" });
    const callsBefore = fake.calls.length;
    fake.failWithAuthOn = ["DELETE"];
    const result = await sweep(ctxOf(harness), config, COMPANY, { ...deps, nowMs: NOW });
    expect(result.tornDown).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(fake.calls.length - callsBefore).toBe(1);
    expect(fake.scripts.has(first.workerName)).toBe(true);
    expect(fake.scripts.has(second.workerName)).toBe(true);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(2);
  });

  it("tears down later envs even when an earlier env keeps 403ing", async () => {
    // A 403 is resource-specific: one stuck env must not starve the rest of
    // the sweep the way a 401 (dead credential) does.
    const { harness, fake, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const old = { ...deps, nowMs: NOW - 5 * 3600 * 1000 };
    const first = await provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...old, randHex: "111111" });
    const second = await provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...old, randHex: "222222" });
    fake.failWithForbiddenOn = [`DELETE /accounts/acct-1/r2/buckets/${first.workerName}`];
    const result = await sweep(ctxOf(harness), config, COMPANY, { ...deps, nowMs: NOW });
    expect(result.tornDown).toEqual([second.envId]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain(first.envId);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(1);
  });

  it("tears down envs whose card is done", async () => {
    const { harness, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const provisioned = await provision(ctxOf(harness), config, run, { issueId: issue.id }, deps);
    await harness.ctx.issues.update(issue.id, { status: "done" }, COMPANY);
    const result = await sweep(ctxOf(harness), config, COMPANY, deps);
    expect(result.tornDown).toEqual([provisioned.envId]);
  });

  it("handleIssueUpdated leaves young provisioning records for the sweep", async () => {
    // A card closed while its provision is still running: tearing the
    // provisioning record down now would pull the index out from under the
    // run, and the later writes would land untracked and leak. Young records
    // stay; the sweep reaps them once stale (or the finished run rolls back).
    const { harness, deps } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const envId = "pct-young-000000";
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: `cf-test-env:env:${envId}` },
      {
        envId,
        issueId: "issue-x",
        companyId: COMPANY,
        projectId: PROJ,
        ownerAgentId: AGENT,
        workerName: envId,
        createdAt: new Date(NOW).toISOString(),
        status: "provisioning",
      },
    );
    await harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY, stateKey: "cf-test-env:index" },
      [envId],
    );
    await handleIssueUpdated(ctxOf(harness), config, COMPANY, "issue-x", "done", { ...deps, nowMs: NOW });
    expect((await allEnvs(harness.ctx, COMPANY)).map((e) => e.envId)).toEqual([envId]);
    // Once stale, the sweep finishes the rollback and drops the record.
    const result = await sweep(ctxOf(harness), config, COMPANY, { ...deps, nowMs: NOW + 31 * 60 * 1000 });
    expect(result.tornDown).toEqual([envId]);
    expect(await allEnvs(harness.ctx, COMPANY)).toHaveLength(0);
  });

  it("handleIssueUpdated only touches the closed card's envs", async () => {
    const { harness, deps, run, issue } = await setup();
    const config = resolveConfig({ ...baseConfig });
    const a = await provision(ctxOf(harness), config, run, { issueId: issue.id }, { ...deps, randHex: "111111" });
    const other = await harness.ctx.issues.create({ companyId: COMPANY, title: "other", projectId: PROJ, assigneeAgentId: AGENT });
    const b = await provision(ctxOf(harness), config, run, { issueId: other.id }, { ...deps, randHex: "222222" });
    await handleIssueUpdated(ctxOf(harness), config, COMPANY, issue.id, "done", deps);
    const remaining = await liveEnvs(harness.ctx, COMPANY);
    expect(remaining.map((e) => e.envId).sort()).toEqual([b.envId].sort());
    void a;
    await handleIssueUpdated(ctxOf(harness), config, COMPANY, other.id, "in_progress", deps);
    expect(await liveEnvs(harness.ctx, COMPANY)).toHaveLength(1);
  });
});

// Helper keeps the call sites short; the harness ctx is the real PluginContext.
import type { PluginContext } from "@paperclipai/plugin-sdk";
function ctxOf(harness: { ctx: PluginContext }): PluginContext {
  return harness.ctx;
}
