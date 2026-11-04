import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { containerCleanupObligation, type ContainerJournalSnapshot } from "./container-journal.js";
import { ContainerCleanupNoticeError, notifyContainerQuarantine, type ContainerCleanupPolicy } from "./container-quarantine.js";

function fixture() {
  const snapshot: ContainerJournalSnapshot = {
    revision: 2, status: "uncertain", claim: { id: "provision", operation: "provision_container" }, approval: null, burnedInteractionIds: [],
    reservation: {
      accountId: "a".repeat(32), companyId: "company", issueId: "source", projectId: "project", ownerAgentId: "agent",
      envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456", generation: 1,
      image: `docker.io/cloudflare/sandbox@sha256:${"b".repeat(64)}`, createdAt: "2026-11-03T12:00:00.000Z", expiresAt: "2026-11-03T15:00:00.000Z",
    },
    facts: [{ kind: "quarantined", reason: "interrupted_attempt" }],
  };
  const policy: ContainerCleanupPolicy = { operatorUserId: "operator", cleanupIssueId: "cleanup-inbox" };
  const inbox = { id: policy.cleanupIssueId, companyId: "company", status: "in_review", assigneeUserId: "operator", assigneeAgentId: null };
  const member = { companyId: "company", principalType: "user", principalId: "operator", status: "active", membershipRole: "member" };
  const read = vi.fn(async () => structuredClone(snapshot));
  const requestConfirmation = vi.fn(async (issueId: string, input: Record<string, unknown>, companyId: string) => ({
    ...input, id: "notice", issueId, companyId, kind: "request_confirmation", status: "pending",
    requestedResolverPolicy: input.resolverPolicy, effectiveResolverPolicy: input.resolverPolicy,
  }));
  const host = {
    issues: { get: vi.fn(async () => ({ ...inbox })), requestConfirmation },
    access: { members: { list: vi.fn(async () => [{ ...member }]) } },
  };
  const invoke = () => notifyContainerQuarantine(host as unknown as Pick<PluginContext, "issues" | "access">,
    { read }, { accountId: snapshot.reservation.accountId, companyId: snapshot.reservation.companyId, policy });
  return { snapshot, policy, inbox, member, read, host, invoke };
}

describe("quarantine cleanup obligation", () => {
  it("retains a conservative Worker-upload obligation without an acknowledged resource ID", () => {
    const { snapshot } = fixture();
    expect(containerCleanupObligation(snapshot)).toMatchObject({
      reason: "interrupted_attempt", possibleUnknownCreates: ["worker_upload"], workerTags: [], namespaceIds: [], applicationIds: [], tokenIds: [],
    });
  });

  it("lists known IDs and all possible create types without treating revoked tokens or absence as settlement", () => {
    const { snapshot } = fixture();
    snapshot.claim = { id: "deploy", operation: "deploy_container" };
    snapshot.facts.unshift(
      { kind: "worker_acknowledged", workerTag: "tag", namespaceId: "namespace", versionId: "version" },
      { kind: "application_intent" }, { kind: "application_acknowledged", id: "app" },
      { kind: "token_intent", name: `${snapshot.reservation.envId}-containers-g1`, expiresAt: "2026-11-03T12:10:00Z" },
      { kind: "token_acknowledged", id: "token" }, { kind: "token_revoked", id: "token" },
      { kind: "absence_verified", resource: "tokens" },
    );
    expect(containerCleanupObligation(snapshot)).toMatchObject({
      possibleUnknownCreates: ["worker_upload", "application_create", "token_mint"], workerTags: ["tag"], namespaceIds: ["namespace"], applicationIds: ["app"], tokenIds: ["token"],
    });
  });

  it.each(["reserved", "ready", "live", "closed"] as const)("does not invent a quarantine obligation from %s", (status) => {
    const { snapshot } = fixture();
    snapshot.status = status;
    snapshot.facts = [];
    expect(() => containerCleanupObligation(snapshot)).toThrow();
  });

  it.each(["unknown reason", "MINT_SECRET_CANARY"])("refuses arbitrary diagnostic strings: %s", (reason) => {
    const { snapshot } = fixture();
    Object.assign(snapshot.facts[0]!, { reason });
    let failure: unknown;
    try { containerCleanupObligation(snapshot); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(reason);
  });

  it("rejects extra credential fields and a removed or nonterminal quarantine marker", () => {
    const { snapshot } = fixture();
    Object.assign(snapshot.facts[0]!, { token: "MINT_SECRET_CANARY" });
    expect(() => containerCleanupObligation(snapshot)).toThrow();
    snapshot.facts = [];
    expect(() => containerCleanupObligation(snapshot)).toThrow();
    snapshot.facts = [{ kind: "quarantined", reason: "interrupted_attempt" }, { kind: "absence_verified", resource: "tokens" }];
    expect(() => containerCleanupObligation(snapshot)).toThrow();
  });
});

describe("operator-visible quarantine notification", () => {
  it("targets a dedicated operator-owned issue with exact env, prefix and unknown calls", async () => {
    const { snapshot, host, read, invoke } = fixture();
    await expect(invoke()).resolves.toEqual({ interactionId: "notice" });
    expect(read).toHaveBeenCalledWith(snapshot.reservation.accountId, "company");
    const [issueId, input, companyId] = host.issues.requestConfirmation.mock.calls[0]!;
    expect(issueId).toBe("cleanup-inbox");
    expect(companyId).toBe("company");
    expect(input).toMatchObject({ resolverPolicy: "human_only", addresseeUserId: "operator", title: `Operator step: clean up quarantined ${snapshot.reservation.envId}` });
    const payload = input.payload as { detailsMarkdown: string };
    expect(payload.detailsMarkdown).toContain(`Resource prefix: \`${snapshot.reservation.envId}\``);
    expect(payload.detailsMarkdown).toContain("worker_upload");
    expect(payload.detailsMarkdown).toContain("Unknown creates may commit later");
    expect(payload.detailsMarkdown).toContain("automatic verified teardown by the original deadline is not claimed");
    expect(payload.detailsMarkdown).toContain("neither releases the journal claim");
    expect(host.issues.get.mock.calls).toHaveLength(2);
    expect(snapshot.status).toBe("uncertain");
  });

  it("uses a stable idempotency key and exact target across delivery retries", async () => {
    const { host, invoke } = fixture();
    await invoke();
    await invoke();
    const inputs = host.issues.requestConfirmation.mock.calls.map((call) => call[1]);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[0]!.idempotencyKey).toMatch(/^container-quarantine:[a-f0-9]{64}:operator$/);
    expect(inputs[0]!.payload).toMatchObject({ target: { type: "custom", key: "cf-test-env:quarantine:pct-abcdef12-123456", revisionNumber: 1 } });
  });

  it("captures policy and journal identity before host awaits", async () => {
    const { policy, host, invoke } = fixture();
    const list = host.access.members.list.getMockImplementation()!;
    host.access.members.list.mockImplementationOnce(async () => {
      policy.operatorUserId = "foreign";
      policy.cleanupIssueId = "foreign-issue";
      return list();
    });
    await invoke();
    expect(host.issues.requestConfirmation.mock.calls[0]![0]).toBe("cleanup-inbox");
    expect(host.issues.requestConfirmation.mock.calls[0]![1].addresseeUserId).toBe("operator");
  });

  it.each(["accepted", "rejected"])("does not release a quarantine after a human %s the notice", async (status) => {
    const { snapshot, host, invoke } = fixture();
    const before = structuredClone(snapshot);
    const request = host.issues.requestConfirmation.getMockImplementation()!;
    host.issues.requestConfirmation.mockImplementationOnce(async (...args) => ({ ...await request(...args), status }));
    await expect(invoke()).resolves.toEqual({ interactionId: "notice" });
    expect(snapshot).toEqual(before);
  });

  it.each(["done", "cancelled", "backlog", "blocked"])("does not post into a %s cleanup issue", async (status) => {
    const { inbox, host, invoke } = fixture();
    inbox.status = status;
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
    expect(host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    { id: "foreign" }, { companyId: "foreign" }, { assigneeUserId: "owner" }, { assigneeAgentId: "agent" },
  ])("refuses wrong inbox identity or assignment: %j", async (patch) => {
    const { inbox, host, invoke } = fixture();
    Object.assign(inbox, patch);
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
    expect(host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it("does not use the possibly closed source issue as the operator inbox", async () => {
    const { policy, snapshot, host, invoke } = fixture();
    policy.cleanupIssueId = snapshot.reservation.issueId;
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
    expect(host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    { companyId: "foreign" }, { principalType: "agent" }, { principalId: "owner" }, { status: "inactive" }, { membershipRole: "viewer" },
  ])("verifies current operator membership before posting: %j", async (patch) => {
    const { member, host, invoke } = fixture();
    Object.assign(member, patch);
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
    expect(host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it.each(["operatorUserId", "cleanupIssueId"] as const)("requires explicit safe %s configuration", async (key) => {
    const { policy, host, invoke } = fixture();
    policy[key] = "";
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
    expect(host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it("refuses policy pass-through and getter fields before reading the journal", async () => {
    const { policy, read, invoke } = fixture();
    Object.assign(policy, { token: "MINT_SECRET_CANARY" });
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
    expect(read).not.toHaveBeenCalled();
    delete (policy as unknown as Record<string, unknown>).token;
    const getter = vi.fn(() => "operator");
    Object.defineProperty(policy, "operatorUserId", { get: getter });
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("reports a sanitized failure on a lost host reply and retries only the notification", async () => {
    const { snapshot, host, invoke } = fixture();
    const before = structuredClone(snapshot);
    host.issues.requestConfirmation.mockRejectedValueOnce(new Error("INTERNAL_TOKEN_SECRET_CANARY"));
    await expect(invoke()).rejects.toThrow("Container environment remains quarantined; operator cleanup notice is not verified.");
    await expect(invoke()).resolves.toEqual({ interactionId: "notice" });
    expect(host.issues.requestConfirmation.mock.calls[0]![1]).toEqual(host.issues.requestConfirmation.mock.calls[1]![1]);
    expect(snapshot).toEqual(before);
    expect(JSON.stringify(host.issues.requestConfirmation.mock.calls)).not.toContain("INTERNAL_TOKEN_SECRET_CANARY");
  });

  it.each([
    { issueId: "foreign" }, { companyId: "foreign" }, { addresseeUserId: "owner" }, { addresseeAgentId: "agent" },
    { effectiveResolverPolicy: "anyone" }, { requestedResolverPolicy: "anyone" }, { status: "expired" }, { payload: {} },
  ])("refuses an unverified host receipt: %j", async (patch) => {
    const { host, invoke } = fixture();
    const request = host.issues.requestConfirmation.getMockImplementation()!;
    host.issues.requestConfirmation.mockImplementationOnce(async (...args) => ({ ...await request(...args), ...patch }));
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
  });

  it("refuses delivery if the operator inbox closes during request creation", async () => {
    const { host, inbox, invoke } = fixture();
    const request = host.issues.requestConfirmation.getMockImplementation()!;
    host.issues.requestConfirmation.mockImplementationOnce(async (...args) => {
      inbox.status = "done";
      return request(...args);
    });
    await expect(invoke()).rejects.toBeInstanceOf(ContainerCleanupNoticeError);
  });

  it("does not reflect arbitrary provider metadata in its reduced receipt", async () => {
    const { host, invoke } = fixture();
    const request = host.issues.requestConfirmation.getMockImplementation()!;
    host.issues.requestConfirmation.mockImplementationOnce(async (...args) => ({ ...await request(...args), diagnostic: "MINT_SECRET_CANARY" }));
    expect(JSON.stringify(await invoke())).not.toContain("MINT_SECRET_CANARY");
  });
});
