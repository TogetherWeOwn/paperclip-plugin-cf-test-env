import { afterEach, describe, expect, it, vi } from "vitest";
import { allEnvs } from "./envs.js";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { D1_EXECUTE_TOOL, PROVISION_TOOL, SWEEP_JOB_KEY, TEARDOWN_TOOL } from "./manifest.js";
import plugin from "./plugin.js";
import { FakeCf } from "./test-support/fake-cf.js";

const COMPANY = "c-1";
const AGENT = "agent-1";
const PROJ = "proj-kofra";

const config = {
  tokenSecretRef: { type: "secret_ref", secretId: "s-1" },
  accountId: "acct-1",
  allowedProjectIds: [PROJ],
  egressCidrs: ["203.0.113.10/32", "2001:db8:8:cb76::/64"],
  workerAdminGroupId: "grp-worker-admin",
  r2ItemWriteGroupId: "grp-r2-item-write",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup({ replayConfig = true } = {}) {
  const harness = createTestHarness({
    manifest,
    config,
    capabilities: [...manifest.capabilities, "issues.create", "issues.update", "issue.documents.read"],
  });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
  if (replayConfig) await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });
  const fake = new FakeCf();
  (harness.ctx.http as { fetch: unknown }).fetch = fake.fetch;
  (harness.ctx.secrets as { resolve: unknown }).resolve = async () => "mint-token";
  const issue = await harness.ctx.issues.create({
    companyId: COMPANY,
    title: "card",
    projectId: PROJ,
    assigneeAgentId: AGENT,
  });
  const run = { agentId: AGENT, runId: "run-1", companyId: COMPANY, projectId: PROJ };
  return { harness, fake, issue, run };
}

const toolData = (res: { data?: unknown }) => {
  const data = res.data as { envId: string; workerName: string; accountId: string; expiresAt: string; token: string };
  expect(data?.envId).toMatch(/^pct-/);
  return data;
};

describe("plugin wiring", () => {
  it("declares the capability, tool and schedule contract", () => {
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        "agent.tools.register",
        "http.outbound",
        "secrets.read-ref",
        "events.subscribe",
        "jobs.schedule",
        "issues.read",
        "issue.documents.write",
        "plugin.state.read",
        "plugin.state.write",
      ]),
    );
    expect(manifest.capabilities).not.toContain("companies.read");
    expect(plugin.definition.multiCompanyConfig).toBe(true);
    expect((manifest.tools ?? []).map((t) => t.name).sort()).toEqual(
      [D1_EXECUTE_TOOL, PROVISION_TOOL, TEARDOWN_TOOL].sort(),
    );
    for (const tool of manifest.tools ?? []) {
      expect(tool.parametersSchema).toBeDefined();
    }
    const jobs = Object.fromEntries((manifest.jobs ?? []).map((j) => [j.jobKey, j.schedule]));
    expect(jobs[SWEEP_JOB_KEY]).toBe("0 * * * *");
    for (const key of [
      "tokenSecretRef",
      "accountId",
      "allowedProjectIds",
      "namePrefix",
      "maxTtlSeconds",
      "maxConcurrentEnvs",
      "egressCidrs",
      "egressCidr",
    ]) {
      expect(manifest.instanceConfigSchema?.properties).toHaveProperty(key);
    }
  });

  it("provisions, queries D1 and tears down end to end through registered tools", async () => {
    const { harness, fake, issue, run } = await setup();
    const provisioned = await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run);
    expect(provisioned.error).toBeUndefined();
    const data = toolData(provisioned);
    expect(data.workerName.startsWith("pct-")).toBe(true);
    expect(typeof data.token).toBe("string");

    const queried = await harness.executeTool(D1_EXECUTE_TOOL, { envId: data.envId, sql: "select 1" }, run);
    expect(queried.error).toBeUndefined();
    expect(fake.d1Queries).toHaveLength(1);

    const torn = await harness.executeTool(TEARDOWN_TOOL, { envId: data.envId }, run);
    expect(torn.error).toBeUndefined();
    expect(torn.data).toEqual({ envId: data.envId, tornDown: true });
    expect(fake.scripts.size).toBe(0);
  });

  // The MCP gateway maps `data` to structuredContent; a result
  // without `data` becomes structuredContent: null and the agent's client
  // rejects the whole result, hiding the real error. Every return path —
  // failure or success — must carry a record `data` plus readable content.
  it("every tool result carries a record data and readable content, failures included", async () => {
    const { harness, issue, run } = await setup();
    const assertShape = (res: { data?: unknown; content?: unknown; error?: string }) => {
      expect(res.data).not.toBeNull();
      expect(typeof res.data).toBe("object");
      expect(Array.isArray(res.data)).toBe(false);
      expect(typeof res.content).toBe("string");
      expect((res.content as string).length).toBeGreaterThan(0);
      if (res.error) {
        expect(res.data).toEqual({ error: { message: res.error } });
        expect(res.content).toContain(res.error);
      }
    };

    // Provision failure (validation and thrown), then success.
    assertShape(await harness.executeTool(PROVISION_TOOL, {}, run));
    const badProvision = await harness.executeTool(PROVISION_TOOL, { issueId: "no-such-issue" }, run);
    expect(badProvision.error).toBeTruthy();
    assertShape(badProvision);
    const provisioned = await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run);
    expect(provisioned.error).toBeUndefined();
    assertShape(provisioned);
    const data = toolData(provisioned);

    // d1_execute failure (unknown env — the exact case the agent never saw),
    // validation failures, then success (data must be a record, not the raw
    // result array).
    assertShape(await harness.executeTool(D1_EXECUTE_TOOL, { sql: "select 1" }, run));
    assertShape(await harness.executeTool(D1_EXECUTE_TOOL, { envId: data.envId }, run));
    const badQuery = await harness.executeTool(D1_EXECUTE_TOOL, { envId: "pct-nope-000000", sql: "select 1" }, run);
    expect(badQuery.error).toMatch(/not found/);
    assertShape(badQuery);
    const queried = await harness.executeTool(D1_EXECUTE_TOOL, { envId: data.envId, sql: "select 1" }, run);
    expect(queried.error).toBeUndefined();
    assertShape(queried);
    expect(queried.data).toEqual({ results: [{ results: [] }] });

    // Teardown validation failure, then success (previously no `data`).
    assertShape(await harness.executeTool(TEARDOWN_TOOL, {}, run));
    const torn = await harness.executeTool(TEARDOWN_TOOL, { envId: data.envId }, run);
    expect(torn.error).toBeUndefined();
    assertShape(torn);
  });

  it("reports an incomplete teardown as a shaped error result", async () => {
    const { harness, fake, issue, run } = await setup();
    const provisioned = await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run);
    const data = toolData(provisioned);
    // failOn matches a substring of "METHOD path"; post-provision only the
    // teardown DELETE touches this script's path.
    fake.failOn = [`workers/scripts/${data.workerName}`];
    const torn = await harness.executeTool(TEARDOWN_TOOL, { envId: data.envId }, run);
    expect(torn.error).toMatch(/Teardown incomplete/);
    expect(torn.data).toEqual({ error: { message: torn.error! } });
    expect(typeof torn.content).toBe("string");
    expect(torn.content).toContain("Teardown incomplete");
  });

  it("tears down the card's env when the card closes", async () => {
    const { harness, fake, issue, run } = await setup();
    const provisioned = await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run);
    expect(provisioned.error).toBeUndefined();
    toolData(provisioned);
    await harness.ctx.issues.update(issue.id, { status: "done" }, COMPANY);
    await harness.emit("issue.updated", {}, { entityId: issue.id, companyId: COMPANY });
    expect(fake.scripts.size).toBe(0);
    expect(fake.revokedTokens).toHaveLength(1);
  });

  it("the hourly sweep reaps expired envs without global company enumeration", async () => {
    const { harness, fake, issue, run } = await setup();
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now - 5 * 3600 * 1000);
    const expired = toolData(await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run));
    vi.setSystemTime(now);
    const live = toolData(await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run));
    // A cron invocation has no companyId. Model the host rejecting wildcard
    // enumeration while another company invocation is active.
    const list = vi.spyOn(harness.ctx.companies, "list").mockRejectedValue(new Error("missing invocation scope"));
    await expect(harness.runJob(SWEEP_JOB_KEY, { trigger: "schedule" })).resolves.toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(fake.scripts.has(expired.workerName)).toBe(false);
    expect(fake.scripts.has(live.workerName)).toBe(true);
    expect(fake.revokedTokens).toHaveLength(1);
    expect((await allEnvs(harness.ctx, COMPANY)).map((env) => env.envId)).toEqual([live.envId]);
  });

  it("refuses to sweep before company config replay without resolving credentials", async () => {
    const { harness } = await setup({ replayConfig: false });
    const getConfig = vi.spyOn(harness.ctx.config, "get");
    const resolveSecret = vi.spyOn(harness.ctx.secrets, "resolve");
    await plugin.definition.onConfigChanged?.(config);
    await plugin.definition.onConfigChanged?.(config, { companyId: null });
    await plugin.definition.onConfigChanged?.(config, { companyId: "  " });
    await expect(harness.runJob(SWEEP_JOB_KEY)).rejects.toThrow("has not received any company configuration");
    expect(getConfig).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("sweeps each configured company once with explicit company-scoped state", async () => {
    const { harness } = await setup();
    await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });
    await plugin.definition.onConfigChanged?.(config, { companyId: "c-2" });
    await plugin.definition.onConfigChanged?.(config, { companyId: null });
    const getConfig = vi.spyOn(harness.ctx.config, "get");
    const getState = vi.spyOn(harness.ctx.state, "get");
    const resolveSecret = vi.spyOn(harness.ctx.secrets, "resolve");
    const list = vi.spyOn(harness.ctx.companies, "list").mockRejectedValue(new Error("missing invocation scope"));
    await harness.runJob(SWEEP_JOB_KEY);
    expect(getConfig.mock.calls).toEqual([[COMPANY], ["c-2"]]);
    expect(getState.mock.calls.map(([key]) => key)).toEqual([
      { scopeKind: "company", scopeId: COMPANY, stateKey: "cf-test-env:index" },
      { scopeKind: "company", scopeId: "c-2", stateKey: "cf-test-env:index" },
    ]);
    expect(list).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("reads fresh config and skips disabled companies without touching state or secrets", async () => {
    const { harness } = await setup();
    harness.setConfig({});
    await plugin.definition.onConfigChanged?.({}, { companyId: COMPANY });
    const getState = vi.spyOn(harness.ctx.state, "get");
    const resolveSecret = vi.spyOn(harness.ctx.secrets, "resolve");
    await harness.runJob(SWEEP_JOB_KEY);
    expect(getState).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("continues other companies after a failure but reports the job failed without raw errors", async () => {
    const { harness } = await setup();
    await plugin.definition.onConfigChanged?.(config, { companyId: "c-2" });
    const secretError = "credential-do-not-log";
    const getConfig = vi.spyOn(harness.ctx.config, "get").mockImplementation(async (companyId) => {
      if (companyId === COMPANY) throw new Error(secretError);
      return config;
    });
    const errorLog = vi.spyOn(harness.ctx.logger, "error");
    const infoLog = vi.spyOn(harness.ctx.logger, "info");
    await expect(harness.runJob(SWEEP_JOB_KEY)).rejects.toThrow("TTL sweep failed for 1 configured companies.");
    expect(getConfig.mock.calls).toEqual([[COMPANY], ["c-2"]]);
    expect(infoLog).toHaveBeenCalledWith("cf-test-env sweep finished", {
      companyId: "c-2", checked: 0, tornDown: 0, errors: 0,
    });
    expect(errorLog).toHaveBeenCalledWith("cf-test-env sweep failed", { companyId: COMPANY });
    expect(JSON.stringify([...errorLog.mock.calls, ...infoLog.mock.calls])).not.toContain(secretError);
  });

  it("marks incomplete expiry cleanup as a failed job and retains the record for retry", async () => {
    const { harness, fake, issue, run } = await setup();
    const data = toolData(await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 3600 * 1000);
    fake.failWithForbiddenOn = [`DELETE /accounts/acct-1/r2/buckets/${data.workerName}`];
    await expect(harness.runJob(SWEEP_JOB_KEY)).rejects.toThrow("TTL sweep failed for 1 configured companies.");
    expect((await allEnvs(harness.ctx, COMPANY)).map((env) => env.envId)).toEqual([data.envId]);
  });

  it("the hourly sweep keeps live envs (expiry paths are covered in envs.test.ts)", async () => {
    const { harness, fake, issue, run } = await setup();
    const provisioned = await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run);
    expect(provisioned.error).toBeUndefined();
    await harness.runJob(SWEEP_JOB_KEY);
    expect(fake.scripts.size).toBe(1);
    expect(fake.revokedTokens).toHaveLength(0);
  });
});
