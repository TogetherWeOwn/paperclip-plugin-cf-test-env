import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  containerApprovalDigest, ContainerApprovalRefusal, readContainerApproval, requestContainerApproval,
  verifyContainerApproval, type ContainerApprovalPin, type ContainerApprovalPolicy,
} from "./container-approval.js";
import type { ContainerIdentity, ContainerOperation } from "./container-contract.js";

const env: ContainerIdentity = {
  accountId: "a".repeat(32), companyId: "company", projectId: "project", issueId: "issue", ownerAgentId: "agent",
  envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456",
  generation: 1, workerTag: "tag", namespaceId: "namespace", applicationId: "app",
  image: `docker.io/cloudflare/sandbox@sha256:${"a".repeat(64)}`,
  createdAt: "2026-11-03T12:00:00Z", expiresAt: "2026-11-03T15:00:00Z",
};
const operation: ContainerOperation = "teardown_container";
const pluginVersion = "0.2.0";
const policy: ContainerApprovalPolicy = { policyDigest: "b".repeat(64), approverUserIds: ["board-user"] };
const digest = containerApprovalDigest(env, operation, pluginVersion, policy);
const createdAt = "2026-11-03T12:05:00.123Z";
const resolvedAt = "2026-11-03T12:06:00.123Z";
const nowMs = Date.parse(resolvedAt) + 1000;
const pin: ContainerApprovalPin = { interactionId: "interaction", sourceRunId: "run", digest, createdAt, expiresAt: "2026-11-03T12:15:00.123Z" };
const interaction = {
  id: pin.interactionId, companyId: env.companyId, issueId: env.issueId, kind: "request_confirmation", sourceRunId: pin.sourceRunId,
  createdByAgentId: env.ownerAgentId, createdByUserId: null, requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
  createdAt, status: "accepted", resolvedAt, resolvedByUserId: "board-user", resolvedByAgentId: null, resolvedByRunId: null,
  payload: { version: 1, target: { type: "custom", key: `cf-test-env:${operation}:${env.envId}`, revisionId: digest, revisionNumber: 1 } },
  result: { version: 1, outcome: "accepted" },
};
const members = [{ companyId: env.companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" }];
const event = {
  companyId: env.companyId, actorType: "user", actorId: "board-user", action: "issue.thread_interaction_accepted",
  entityType: "issue", entityId: env.issueId, createdAt: resolvedAt,
  details: { interactionId: pin.interactionId, interactionKind: "request_confirmation", interactionStatus: "accepted", resolutionActorKind: "user", effectiveResolverPolicy: "human_only" },
};
const evidence = { env, operation, pluginVersion, policy, pin, interaction, members, audit: [event], nowMs };

function hostFixture() {
  return {
    issues: { listInteractions: vi.fn(async () => [interaction]), requestConfirmation: vi.fn(async () => ({ ...interaction, status: "pending", result: null })) },
    access: { members: { list: vi.fn(async () => members) } },
    authorization: { audit: { search: vi.fn(async () => [event]) } },
  };
}
const asHost = (host: ReturnType<typeof hostFixture>) => host as unknown as Pick<PluginContext, "issues" | "access" | "authorization">;

describe("independent, exact-operation approval evidence", () => {
  it("requires all three host surfaces and preserves Date precision", () => {
    expect(() => verifyContainerApproval(evidence)).not.toThrow();
    expect(() => verifyContainerApproval({ ...evidence, interaction: { ...interaction, createdAt: new Date(createdAt), resolvedAt: new Date(resolvedAt) } })).not.toThrow();
  });

  it.each([
    { status: "pending" }, { status: "rejected" }, { result: { version: 1, outcome: "stale_target" } },
    { result: { version: 1, outcome: "superseded_by_comment" } }, { result: { outcome: "accepted" } },
    { id: "caller-selected" }, { companyId: "foreign" }, { issueId: "foreign" }, { kind: "ask_user_questions" },
    { sourceRunId: "foreign" }, { createdByAgentId: "foreign" }, { createdByUserId: "board-user" },
    { requestedResolverPolicy: "anyone" }, { effectiveResolverPolicy: "not_creator" },
    { resolvedByAgentId: env.ownerAgentId }, { resolvedByRunId: "agent-run" }, { resolvedByUserId: "unapproved-user" },
    { addresseeUserId: "different-user" }, { addresseeAgentId: env.ownerAgentId },
    { createdAt: "2026-11-03T12:04:00Z" }, { resolvedAt: "invalid" }, { resolvedAt: "2026-11-03T12:04:00Z" },
    { resolvedAt: pin.expiresAt }, { resolvedAt: "2026-11-03T12:08:00Z" },
    { payload: { ...interaction.payload, target: { ...interaction.payload.target, revisionNumber: 2 } } },
    { payload: { ...interaction.payload, target: { ...interaction.payload.target, revisionId: "c".repeat(64) } } },
    { payload: { ...interaction.payload, target: { ...interaction.payload.target, key: "delete-all" } } },
  ])("refuses stale, self-approved, foreign or unbound interactions %j", (patch) => {
    expect(() => verifyContainerApproval({ ...evidence, interaction: { ...interaction, ...patch } })).toThrow(ContainerApprovalRefusal);
  });

  it.each([
    { consumedAt: resolvedAt }, { expiresAt: resolvedAt }, { expiresAt: "2026-11-03T12:16:00.123Z" },
    { sourceRunId: "foreign" }, { interactionId: "foreign" }, { digest: "c".repeat(64) }, { createdAt: "invalid" },
  ])("refuses replay, expiry and corrupt durable pins %j", (patch) => {
    expect(() => verifyContainerApproval({ ...evidence, pin: { ...pin, ...patch } })).toThrow(ContainerApprovalRefusal);
  });

  it.each([
    { actorType: "plugin" }, { actorType: "agent" }, { actorType: "system" }, { actorId: "unapproved-user" },
    { action: "issue.updated" }, { companyId: "foreign" }, { entityId: "foreign" },
    { createdAt: "2026-11-03T12:05:00Z" }, { createdAt: pin.expiresAt },
    { details: { ...event.details, interactionId: "foreign" } },
    { details: { ...event.details, resolutionActorKind: "plugin" } },
    { details: { ...event.details, interactionStatus: "expired" } },
  ])("rejects relayed attribution or nonmatching audit proof %j", (patch) => {
    expect(() => verifyContainerApproval({ ...evidence, audit: [{ ...event, ...patch }] })).toThrow(ContainerApprovalRefusal);
  });

  it.each([
    { companyId: "foreign" }, { principalType: "agent" }, { principalId: "different-user" },
    { status: "suspended" }, { membershipRole: "viewer" }, { membershipRole: null },
  ])("rechecks current approver membership and authority %j", (patch) => {
    expect(() => verifyContainerApproval({ ...evidence, members: [{ ...members[0], ...patch }] })).toThrow(ContainerApprovalRefusal);
  });

  it("fails closed on missing audit evidence, membership, invalid clocks or changed policy", () => {
    expect(() => verifyContainerApproval({ ...evidence, audit: [] })).toThrow(ContainerApprovalRefusal);
    expect(() => verifyContainerApproval({ ...evidence, members: [] })).toThrow(ContainerApprovalRefusal);
    expect(() => verifyContainerApproval({ ...evidence, nowMs: NaN })).toThrow(ContainerApprovalRefusal);
    expect(() => verifyContainerApproval({ ...evidence, policy: { ...policy, policyDigest: "c".repeat(64) } })).toThrow(ContainerApprovalRefusal);
    expect(() => verifyContainerApproval({ ...evidence, policy: { ...policy, approverUserIds: [] } })).toThrow(ContainerApprovalRefusal);
    expect(() => verifyContainerApproval({ ...evidence, env: { ...env, generation: 2 } })).toThrow(ContainerApprovalRefusal);
    expect(() => verifyContainerApproval({ ...evidence, operation: "deploy_container" })).toThrow(ContainerApprovalRefusal);
  });

  it("binds policy principals independent of list order and invalidates changed routing", () => {
    const p = { ...policy, approverUserIds: ["board-user", "other-user"] };
    expect(containerApprovalDigest(env, operation, pluginVersion, p))
      .toBe(containerApprovalDigest(env, operation, pluginVersion, { ...p, approverUserIds: [...p.approverUserIds].reverse() }));
    expect(containerApprovalDigest(env, operation, pluginVersion, p)).not.toBe(digest);
    expect(() => containerApprovalDigest(env, operation, pluginVersion, { ...policy, approverUserIds: ["board-user", "board-user"] })).toThrow(ContainerApprovalRefusal);
  });
});

describe("host approval adapter", () => {
  it("creates a bound human-only request without requesting resolution capability", async () => {
    const host = hostFixture();
    expect(await requestContainerApproval(asHost(host), { env, operation, pluginVersion, policy, sourceRunId: "run" }, () => nowMs)).toEqual(pin);
    expect(host.issues.requestConfirmation).toHaveBeenCalledWith(env.issueId, expect.objectContaining({
      resolverPolicy: "human_only", addresseeUserId: "board-user", sourceRunId: "run", continuationPolicy: "wake_assignee",
      payload: expect.objectContaining({ target: interaction.payload.target }),
    }), env.companyId, { authorAgentId: env.ownerAgentId });
    expect(host.authorization.audit.search).not.toHaveBeenCalled();
  });

  it("checks a pinned interaction, active member and positive user-origin audit event", async () => {
    const host = hostFixture();
    await expect(readContainerApproval(asHost(host), { env, operation, pluginVersion, policy, pin, nowMs })).resolves.toBeUndefined();
    expect(host.authorization.audit.search).toHaveBeenCalledWith(expect.objectContaining({ actorType: "user", companyId: env.companyId, entityId: env.issueId }));
  });

  it("never adopts another accepted interaction instead of the pinned ID", async () => {
    const host = hostFixture();
    host.issues.listInteractions.mockResolvedValue([{ ...interaction, id: "foreign" }]);
    await expect(readContainerApproval(asHost(host), { env, operation, pluginVersion, policy, pin, nowMs })).rejects.toThrow(ContainerApprovalRefusal);
    expect(host.authorization.audit.search).not.toHaveBeenCalled();
  });

  it("sanitizes capability denials and never treats them as approval", async () => {
    const host = hostFixture();
    const canary = "credential-canary";
    host.authorization.audit.search.mockRejectedValue(new Error(canary));
    let failure: unknown;
    try { await readContainerApproval(asHost(host), { env, operation, pluginVersion, policy, pin, nowMs }); } catch (err) { failure = err; }
    expect(failure).toBeInstanceOf(ContainerApprovalRefusal);
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect((failure as Error).cause).toBeUndefined();
  });
});
