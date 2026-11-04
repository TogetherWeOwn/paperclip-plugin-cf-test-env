import { describe, expect, it, vi } from "vitest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { authorizeContainerEnv, authorizeContainerProvision, ContainerAccessRefusal } from "./container-access.js";
import type { ContainerIdentity } from "./container-contract.js";

const run: ToolRunContext = { companyId: "company", projectId: "project", agentId: "agent", runId: "run" };
const env: ContainerIdentity = {
  accountId: "a".repeat(32), companyId: "company", issueId: "issue", projectId: "project", ownerAgentId: "agent",
  envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456", generation: 1,
  workerTag: "tag", namespaceId: "namespace", image: `docker.io/cloudflare/sandbox@sha256:${"a".repeat(64)}`,
  createdAt: "2026-11-03T12:00:00Z", expiresAt: "2026-11-03T15:00:00Z",
};
const nowMs = Date.parse("2026-11-03T12:01:00Z");
const issue = { id: "issue", companyId: "company", projectId: "project", assigneeAgentId: "agent", assigneeUserId: null, status: "in_progress" };
const ownership = { issueId: "issue", assigneeAgentId: "agent", checkoutRunId: "run", adoptedFromRunId: null, status: "in_progress" };
const config = { accountId: env.accountId, allowedProjectIds: ["project"], tokenSecretRef: { type: "secret_ref", secretId: "not-read" } };

function fixture() {
  return {
    config: { get: vi.fn(async () => config) },
    issues: { get: vi.fn(async () => issue), assertCheckoutOwner: vi.fn(async () => ownership) },
    secrets: { resolve: vi.fn() }, http: { fetch: vi.fn() }, logger: { info: vi.fn(), error: vi.fn() },
  };
}
const asHost = (host: ReturnType<typeof fixture>) => host as unknown as Pick<PluginContext, "config" | "issues">;

async function refused(host: ReturnType<typeof fixture>, call: Promise<unknown>) {
  await expect(call).rejects.toThrow(ContainerAccessRefusal);
  expect(host.secrets.resolve).not.toHaveBeenCalled();
  expect(host.http.fetch).not.toHaveBeenCalled();
  expect(host.logger.error).not.toHaveBeenCalled();
}

describe("current authenticated container caller gate", () => {
  it("checks exact company/issue/assignee/project/checkout and returns no provider or secret metadata", async () => {
    const host = fixture();
    const caller = await authorizeContainerEnv(asHost(host), run, env, () => nowMs);
    expect(caller).toEqual({ companyId: "company", issueId: "issue", projectId: "project", ownerAgentId: "agent", runId: "run", accountId: env.accountId });
    expect(host.issues.get.mock.calls).toHaveLength(2);
    expect(host.issues.assertCheckoutOwner).toHaveBeenCalledWith({ issueId: "issue", companyId: "company", actorAgentId: "agent", actorRunId: "run" });
    expect(host.config.get).toHaveBeenCalledTimes(2);
    expect(host.secrets.resolve).not.toHaveBeenCalled();
    expect(host.http.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(caller)).not.toContain("not-read");
  });

  it.each([
    { companyId: "foreign" }, { projectId: "foreign" }, { agentId: "foreign" }, { runId: "" }, { runId: "run/path" },
  ])("refuses foreign or malformed authenticated context %j", async (patch) => {
    const host = fixture();
    await refused(host, authorizeContainerEnv(asHost(host), { ...run, ...patch }, env, () => nowMs));
    expect(host.issues.assertCheckoutOwner).not.toHaveBeenCalled();
  });

  it.each([
    { id: "foreign" }, { companyId: "foreign" }, { projectId: "foreign" }, { projectId: null },
    { assigneeAgentId: "foreign" }, { assigneeAgentId: null }, { assigneeUserId: "board-user" },
    { status: "done" }, { status: "cancelled" }, { status: "todo" }, { status: "blocked" }, { status: "in_review" }, { status: "unknown" },
  ])("rejects current card mismatch before checkout and secrets %j", async (patch) => {
    const host = fixture();
    host.issues.get.mockResolvedValue({ ...issue, ...patch } as typeof issue);
    await refused(host, authorizeContainerProvision(asHost(host), run, "issue"));
    expect(host.issues.assertCheckoutOwner).not.toHaveBeenCalled();
  });

  it.each([
    { issueId: "foreign" }, { assigneeAgentId: "foreign" }, { checkoutRunId: "foreign" }, { checkoutRunId: null }, { status: "done" },
  ])("refuses stale or missing checkout ownership %j", async (patch) => {
    const host = fixture();
    host.issues.assertCheckoutOwner.mockResolvedValue({ ...ownership, ...patch } as typeof ownership);
    await refused(host, authorizeContainerProvision(asHost(host), run, "issue"));
  });

  it.each([
    { accountId: "" }, { accountId: "invalid" }, { allowedProjectIds: [] }, { allowedProjectIds: ["foreign"] },
    { allowedProjectIds: ["project", ""] }, { allowedProjectIds: ["project", 42] },
  ])("refuses absent or malformed current config %j", async (patch) => {
    const host = fixture();
    host.config.get.mockResolvedValue({ ...config, ...patch } as typeof config);
    await refused(host, authorizeContainerProvision(asHost(host), run, "issue"));
  });

  it.each([{ status: "cancelled" }, { assigneeAgentId: "foreign" }, { projectId: "foreign" }])("rechecks card state after checkout %j", async (patch) => {
    const host = fixture();
    host.issues.get.mockResolvedValueOnce(issue).mockResolvedValueOnce({ ...issue, ...patch });
    await refused(host, authorizeContainerProvision(asHost(host), run, "issue"));
  });

  it.each([{ accountId: "b".repeat(32) }, { allowedProjectIds: [] }])("rechecks current config before returning %j", async (patch) => {
    const host = fixture();
    host.config.get.mockResolvedValueOnce(config).mockResolvedValueOnce({ ...config, ...patch });
    await refused(host, authorizeContainerProvision(asHost(host), run, "issue"));
  });

  it("refuses an env recorded for a different account even if the project is allowed", async () => {
    const host = fixture();
    await refused(host, authorizeContainerEnv(asHost(host), run, { ...env, accountId: "b".repeat(32) }, () => nowMs));
  });

  it.each([NaN, Date.parse(env.createdAt) - 1, Date.parse(env.expiresAt) - 300000, Date.parse(env.expiresAt)])("rejects expiry and invalid clocks before host work: %s", async (clock) => {
    const host = fixture();
    await refused(host, authorizeContainerEnv(asHost(host), run, env, () => clock));
    expect(host.config.get).not.toHaveBeenCalled();
  });

  it("rechecks expiry after asynchronous host verification", async () => {
    const host = fixture();
    const clock = vi.fn().mockReturnValueOnce(nowMs).mockReturnValueOnce(Date.parse(env.expiresAt));
    await refused(host, authorizeContainerEnv(asHost(host), run, env, clock));
    expect(host.issues.assertCheckoutOwner).toHaveBeenCalledOnce();
  });

  it.each(["config", "issue", "checkout"])('sanitizes host exceptions and never logs them: %s', async (surface) => {
    const host = fixture();
    const fail = async () => { throw new Error("MINT_SECRET_CANARY INTERNAL_SECRET_CANARY"); };
    if (surface === "config") host.config.get.mockImplementation(fail);
    if (surface === "issue") host.issues.get.mockImplementation(fail);
    if (surface === "checkout") host.issues.assertCheckoutOwner.mockImplementation(fail);
    await expect(authorizeContainerProvision(asHost(host), run, "issue")).rejects.toThrow("Current container environment ownership and checkout could not be verified.");
    expect(host.secrets.resolve).not.toHaveBeenCalled();
    expect(host.http.fetch).not.toHaveBeenCalled();
    expect(host.logger.error).not.toHaveBeenCalled();
  });
});
