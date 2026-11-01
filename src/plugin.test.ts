import { describe, expect, it } from "vitest";
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
  egressCidr: "203.0.113.0/24",
  workerAdminGroupId: "grp-worker-admin",
  r2ItemWriteGroupId: "grp-r2-item-write",
};

async function setup() {
  const harness = createTestHarness({
    manifest,
    config,
    capabilities: [...manifest.capabilities, "issues.create", "issues.update", "issue.documents.read"],
  });
  harness.seed({ companies: [{ id: COMPANY, name: "TWO", issuePrefix: "TWO" } as never] });
  await plugin.definition.setup(harness.ctx);
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
    expect(fake.scripts.size).toBe(0);
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

  it("the hourly sweep keeps live envs (expiry paths are covered in envs.test.ts)", async () => {
    const { harness, fake, issue, run } = await setup();
    const provisioned = await harness.executeTool(PROVISION_TOOL, { issueId: issue.id }, run);
    expect(provisioned.error).toBeUndefined();
    await harness.runJob(SWEEP_JOB_KEY);
    expect(fake.scripts.size).toBe(1);
    expect(fake.revokedTokens).toHaveLength(0);
  });
});
