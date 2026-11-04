import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { containerApprovalDigest, type ContainerApprovalPin, type ContainerApprovalPolicy } from "./container-approval.js";
import { CONTAINER_DATABASE_NAMESPACE, ContainerJournal, ContainerJournalError, type ContainerJournalSnapshot, type ContainerReservation } from "./container-journal.js";
import type { ContainerIdentity, ContainerOperation } from "./container-contract.js";
import { deployContainerApplication, reconcileContainerAttempt, type ContainerDeploymentPolicy } from "./container-lifecycle.js";
import { CONTAINERS_GROUP_NAME, containerTokenRequest } from "./container-credentials.js";

const databaseUrl = process.env.CF_BROKER_TEST_DATABASE_URL;
if (process.env.CF_BROKER_REQUIRE_DATABASE_TESTS === "1" && !databaseUrl) throw new Error("An isolated broker test database is required.");
function assertTestDatabaseUrl(value: string) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/cf_broker_test") {
    throw new Error("Broker SQL fixtures require a loopback cf_broker_test database.");
  }
}
if (databaseUrl) assertTestDatabaseUrl(databaseUrl);
const table = `"${CONTAINER_DATABASE_NAMESPACE}".container_slots`;
const accounts: string[] = [];
const createdAt = "2026-11-03T12:00:00.000Z";
const nowMs = Date.parse("2026-11-03T12:06:01.000Z");
const version = "0.2.0";
const policy: ContainerApprovalPolicy = { policyDigest: "b".repeat(64), approverUserIds: ["board-user"] };

function reservation(): ContainerReservation {
  const accountId = randomBytes(16).toString("hex");
  accounts.push(accountId);
  return {
    accountId, companyId: "company", issueId: "issue", projectId: "project", ownerAgentId: "agent",
    envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456", generation: 1,
    image: `docker.io/cloudflare/sandbox@sha256:${"a".repeat(64)}`, createdAt, expiresAt: "2026-11-03T15:00:00.000Z",
  };
}

function approvalFixture(snapshot: ContainerJournalSnapshot, operation: ContainerOperation = "teardown_container") {
  const env: ContainerIdentity = { ...snapshot.reservation, workerTag: "tag", namespaceId: "namespace" };
  const app = snapshot.facts.find((fact) => fact.kind === "application_acknowledged");
  if (app?.kind === "application_acknowledged") env.applicationId = app.id;
  const pin: ContainerApprovalPin = {
    interactionId: randomBytes(16).toString("hex"), sourceRunId: "run", digest: containerApprovalDigest(env, operation, version, policy),
    createdAt: "2026-11-03T12:05:00.000Z", expiresAt: "2026-11-03T12:15:00.000Z",
  };
  const resolvedAt = "2026-11-03T12:06:00.000Z";
  const interaction = {
    id: pin.interactionId, companyId: env.companyId, issueId: env.issueId, kind: "request_confirmation", sourceRunId: pin.sourceRunId,
    createdByAgentId: env.ownerAgentId, createdByUserId: null, requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
    createdAt: pin.createdAt, status: "accepted", resolvedAt, resolvedByUserId: "board-user", resolvedByAgentId: null, resolvedByRunId: null,
    payload: { version: 1, target: { type: "custom", key: `cf-test-env:${operation}:${env.envId}`, revisionId: pin.digest, revisionNumber: 1 } },
    result: { version: 1, outcome: "accepted" },
  };
  const host = {
    issues: { listInteractions: vi.fn(async () => [interaction]) },
    access: { members: { list: vi.fn(async () => [{ companyId: env.companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" }]) } },
    authorization: { audit: { search: vi.fn(async () => [{
      companyId: env.companyId, actorType: "user", actorId: "board-user", action: "issue.thread_interaction_accepted",
      entityType: "issue", entityId: env.issueId, createdAt: resolvedAt,
      details: { interactionId: pin.interactionId, interactionKind: "request_confirmation", interactionStatus: "accepted", resolutionActorKind: "user", effectiveResolverPolicy: "human_only" },
    }]) } },
  };
  return { pin, host, input: { attemptId: "operation", operation, host: host as unknown as Pick<PluginContext, "issues" | "access" | "authorization">, pluginVersion: version, policy } };
}

function adapter(client: Client): PluginContext["db"] {
  return {
    namespace: CONTAINER_DATABASE_NAMESPACE,
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => (await client.query(sql, params)).rows as T[],
    execute: async (sql, params) => ({ rowCount: (await client.query(sql, params)).rowCount ?? 0 }),
  };
}

async function ready(journal: ContainerJournal) {
  let snapshot = await journal.reserve(reservation(), "provision");
  snapshot = await journal.append(snapshot, "provision", { kind: "worker_acknowledged", workerTag: "tag", namespaceId: "namespace", versionId: "version" });
  return journal.finish(snapshot, "provision", "ready");
}

// Real PostgreSQL connections: no JS mutex, fake upsert or in-memory CAS adapter.
// CI requires this suite. Local runs without a database explicitly report skips.
describe.skipIf(!databaseUrl)("PostgreSQL container reservation and one-shot consumption", () => {
  let first: Client;
  let second: Client;
  let db: PluginContext["db"];
  let journal: ContainerJournal;
  let other: ContainerJournal;

  beforeAll(async () => {
    first = new Client({ connectionString: databaseUrl });
    second = new Client({ connectionString: databaseUrl });
    await first.connect();
    await second.connect();
    await first.query(`CREATE SCHEMA IF NOT EXISTS "${CONTAINER_DATABASE_NAMESPACE}"`);
    const exists = await first.query("SELECT to_regclass($1) AS name", [`${CONTAINER_DATABASE_NAMESPACE}.container_slots`]);
    if (exists.rows[0].name === null) await first.query(await readFile(new URL("../migrations/001_container_slots.sql", import.meta.url), "utf8"));
    db = adapter(first);
    journal = new ContainerJournal(db);
    other = new ContainerJournal(adapter(second));
  });

  afterAll(async () => {
    try { if (first) await first.query(`DELETE FROM ${table} WHERE account_id = ANY($1::text[])`, [accounts]); }
    finally { await Promise.all([first?.end(), second?.end()]); }
  });

  it("reserves at most one slot across different companies and independent connections", async () => {
    const env = reservation();
    const results = await Promise.allSettled([
      journal.reserve(env, "first"), other.reserve({ ...env, companyId: "different-company", envId: "pct-abcdef12-654321", workerName: "pct-abcdef12-654321", applicationName: "pct-abcdef12-654321" }, "second"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: "conflict" });
    expect((await first.query(`SELECT * FROM ${table} WHERE account_id = $1`, [env.accountId])).rows).toHaveLength(1);
  });

  it("does not expose foreign-company state or treat an invisible slot as capacity", async () => {
    const env = reservation();
    await journal.reserve(env, "first");
    expect(await other.read(env.accountId, "different-company")).toBeNull();
    await expect(other.reserve({ ...env, companyId: "different-company" }, "second")).rejects.toMatchObject({ code: "conflict" });
  });

  it("uses conditional updates rather than a read followed by unconditional upsert", async () => {
    const snapshot = await journal.reserve(reservation(), "provision");
    const results = await Promise.allSettled([
      journal.append(snapshot, "provision", { kind: "worker_acknowledged", workerTag: "first-tag", namespaceId: "first-namespace", versionId: "first-version" }),
      other.append(snapshot, "provision", { kind: "worker_acknowledged", workerTag: "tag", namespaceId: "namespace", versionId: "version" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stored = await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId);
    expect(stored?.revision).toBe(2);
    expect(stored?.facts).toHaveLength(1);
    await expect(journal.append(snapshot, "provision", { kind: "worker_acknowledged", workerTag: "stale", namespaceId: "namespace", versionId: "version" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a fabricated identity even with the real account and revision", async () => {
    const snapshot = await journal.reserve(reservation(), "provision");
    const tampered = { ...snapshot, reservation: { ...snapshot.reservation, ownerAgentId: "foreign" } };
    await expect(other.append(tampered, "provision", { kind: "worker_acknowledged", workerTag: "tag", namespaceId: "namespace", versionId: "version" })).rejects.toMatchObject({ code: "conflict" });
    expect(await journal.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it("preserves a durable claim through a new journal instance instead of stealing it", async () => {
    const snapshot = await journal.reserve(reservation(), "provision");
    const stored = await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId);
    expect(stored?.claim).toEqual({ id: "provision", operation: "provision_container" });
    await expect(other.append(stored!, "different-attempt", { kind: "application_intent" })).rejects.toMatchObject({ code: "conflict" });
    await expect(other.reserve(snapshot.reservation, "restart")).rejects.toMatchObject({ code: "conflict" });
  });

  it("atomically burns approval and acquires the claim once across two connections", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    let remoteCalls = 0;
    const attempt = async (client: ContainerJournal, attemptId: string) => {
      const receipt = await client.beginApproved(snapshot, { ...input, attemptId }, () => nowMs);
      remoteCalls++;
      return receipt;
    };
    const results = await Promise.allSettled([attempt(journal, "first"), attempt(other, "second")]);
    expect(remoteCalls).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stored = await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId);
    expect(stored?.burnedInteractionIds).toEqual([pin.interactionId]);
    expect(stored?.approval?.pin.consumedAt).toBe(new Date(nowMs).toISOString());
    expect(["first", "second"]).toContain(stored?.claim?.id);
    await expect(other.beginApproved(stored!, input, () => nowMs)).rejects.toMatchObject({ code: "approval_required" });
  });

  it("retains burned consent and claim when the commit succeeds but its reply is lost", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    const failAfterCommit = new ContainerJournal({ ...db, execute: async (sql, params) => {
      await db.execute(sql, params);
      throw new Error("DATABASE_SECRET_CANARY");
    } });
    let remoteCalls = 0;
    await expect(failAfterCommit.beginApproved(snapshot, input, () => nowMs).then(() => remoteCalls++)).rejects.toMatchObject({ code: "unavailable" });
    expect(remoteCalls).toBe(0);
    const stored = await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId);
    expect(stored?.burnedInteractionIds).toEqual([pin.interactionId]);
    expect(stored?.claim).not.toBeNull();
    await expect(other.beginApproved(snapshot, input, () => nowMs)).rejects.toMatchObject({ code: "conflict" });
    expect(JSON.stringify(stored)).not.toContain("DATABASE_SECRET_CANARY");
  });

  it("refuses approval expiring during host verification without consuming it", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    const clock = vi.fn().mockReturnValueOnce(nowMs).mockReturnValueOnce(Date.parse(pin.expiresAt));
    await expect(journal.beginApproved(snapshot, input, clock)).rejects.toMatchObject({ code: "approval_required" });
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it("rejects missing independent evidence before any SQL burn", async () => {
    let snapshot = await ready(journal);
    const fixture = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, fixture.input.operation, fixture.pin);
    fixture.host.authorization.audit.search.mockResolvedValue([]);
    await expect(journal.beginApproved(snapshot, fixture.input, () => nowMs)).rejects.toThrow("Independent, current container approval could not be verified.");
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it("requires the exact operation and denies caller-selected approval flags", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    await expect(journal.beginApproved(snapshot, { ...input, operation: "deploy_container" }, () => nowMs)).rejects.toMatchObject({ code: "approval_required" });
    await expect(journal.pinApproval(snapshot, input.operation, { ...pin, approved: true } as ContainerApprovalPin)).rejects.toMatchObject({ code: "invalid_journal" });
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it("retains the closed account slot and permanently rejects replay of burned consent", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    snapshot = await journal.beginApproved(snapshot, input, () => nowMs);
    await expect(journal.finish(snapshot, input.attemptId, "closed")).rejects.toMatchObject({ code: "invalid_journal" });
    for (const resource of ["application", "worker", "tokens"] as const) snapshot = await journal.append(snapshot, input.attemptId, { kind: "absence_verified", resource });
    snapshot = await journal.finish(snapshot, input.attemptId, "closed");
    expect(snapshot.claim).toBeNull();
    await expect(other.reserve(snapshot.reservation, "new-window")).rejects.toMatchObject({ code: "conflict" });
    await expect(other.pinApproval(snapshot, input.operation, pin)).rejects.toMatchObject({ code: "conflict" });
  });

  it("requires intent before application acknowledgement and refuses overlapping deployment", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot, "deploy_container");
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    snapshot = await journal.beginApproved(snapshot, input, () => nowMs);
    await expect(journal.append(snapshot, input.attemptId, { kind: "application_acknowledged", id: "app" })).rejects.toMatchObject({ code: "invalid_journal" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "application_intent" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "application_acknowledged", id: "app" });
    snapshot = await journal.finish(snapshot, input.attemptId, "live");
    const next = approvalFixture(snapshot, "deploy_container");
    snapshot = await journal.pinApproval(snapshot, next.input.operation, next.pin);
    await expect(journal.beginApproved(snapshot, next.input, () => nowMs)).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not retain mutable caller objects across a reservation await", async () => {
    const env = reservation();
    const expected = structuredClone(env);
    const pending = journal.reserve(env, "provision");
    env.ownerAgentId = "foreign";
    const receipt = await pending;
    expect(receipt.reservation).toEqual(expected);
    expect((await other.read(expected.accountId, expected.companyId))?.reservation).toEqual(expected);
  });

  it("keeps the original CAS baseline when a caller refreshes its snapshot during verification", async () => {
    let snapshot = await ready(journal);
    const { pin, input, host } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    const original = structuredClone(snapshot);
    const search = host.authorization.audit.search.getMockImplementation()!;
    let winner: ContainerJournalSnapshot | undefined;
    host.authorization.audit.search.mockImplementationOnce(async () => {
      winner = await other.beginApproved(original, { ...input, attemptId: "winner" }, () => nowMs);
      Object.assign(snapshot, winner);
      return search();
    });
    await expect(journal.beginApproved(snapshot, input, () => nowMs)).rejects.toMatchObject({ code: "conflict" });
    expect(await other.read(original.reservation.accountId, original.reservation.companyId)).toEqual(winner);
  });

  it("captures the operation and attempt before asynchronous verification", async () => {
    let snapshot = await ready(journal);
    const { pin, input, host } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    const search = host.authorization.audit.search.getMockImplementation()!;
    host.authorization.audit.search.mockImplementationOnce(async () => {
      input.operation = "deploy_container";
      input.attemptId = "changed";
      return search();
    });
    const receipt = await journal.beginApproved(snapshot, input, () => nowMs);
    expect(receipt.claim).toEqual({ operation: "teardown_container", id: "operation" });
  });

  it.each(["consent", "deployment"])("retains the burn and claim if %s expires while awaiting the write receipt", async (boundary) => {
    let snapshot = await ready(journal);
    const { pin, input, host } = approvalFixture(snapshot, "deploy_container");
    const start = boundary === "consent" ? nowMs : Date.parse(snapshot.reservation.expiresAt) - 300001;
    if (boundary === "deployment") {
      // Move the fixture's approval/audit evidence together to the cutoff window.
      const shift = start - nowMs;
      pin.createdAt = new Date(Date.parse(pin.createdAt) + shift).toISOString();
      pin.expiresAt = new Date(Date.parse(pin.expiresAt) + shift).toISOString();
      const interaction = (await host.issues.listInteractions())[0]!;
      Object.assign(interaction, { createdAt: pin.createdAt, resolvedAt: new Date(start - 1000).toISOString() });
      const evidence = (await host.authorization.audit.search())[0]!;
      host.authorization.audit.search.mockResolvedValue([{ ...evidence, createdAt: new Date(start - 1000).toISOString() }]);
    }
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    let clock = start;
    const delayed = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const receipt = await db.execute(sql, params);
      clock = boundary === "consent" ? Date.parse(pin.expiresAt) : start + 1;
      return receipt;
    } });
    let remoteCalls = 0;
    await expect(delayed.beginApproved(snapshot, input, () => clock).then(() => remoteCalls++)).rejects.toThrow();
    expect(remoteCalls).toBe(0);
    const stored = await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId);
    expect(stored?.burnedInteractionIds).toContain(pin.interactionId);
    expect(stored?.claim?.id).toBe(input.attemptId);
  });

  it("does not grant a Containers mint gate to unapproved provisioning", async () => {
    const snapshot = await journal.reserve(reservation(), "provision");
    await expect(journal.append(snapshot, "provision", { kind: "token_intent", name: `${snapshot.reservation.envId}-containers-g1`, expiresAt: "2026-11-03T12:10:00Z" })).rejects.toMatchObject({ code: "invalid_journal" });
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it.each([false, true])("does not release a deployment without an acknowledged application (intent=%s)", async (intent) => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot, "deploy_container");
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    snapshot = await journal.beginApproved(snapshot, input, () => nowMs);
    if (intent) snapshot = await journal.append(snapshot, input.attemptId, { kind: "application_intent" });
    await expect(journal.finish(snapshot, input.attemptId, "live")).rejects.toMatchObject({ code: "invalid_journal" });
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it.each([false, true])("retains exclusivity for unresolved credential work (acknowledged=%s)", async (acknowledged) => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot, "deploy_container");
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    snapshot = await journal.beginApproved(snapshot, input, () => nowMs);
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "application_intent" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "application_acknowledged", id: "app" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "token_intent", name: `${snapshot.reservation.envId}-containers-g1`, expiresAt: "2026-11-03T12:10:00Z" });
    if (acknowledged) snapshot = await journal.append(snapshot, input.attemptId, { kind: "token_acknowledged", id: "token" });
    await expect(journal.finish(snapshot, input.attemptId, "live")).rejects.toMatchObject({ code: "invalid_journal" });
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
    if (acknowledged) {
      snapshot = await journal.append(snapshot, input.attemptId, { kind: "token_revoked", id: "token" });
      expect((await journal.finish(snapshot, input.attemptId, "live")).claim).toBeNull();
    }
  });

  it("does not use historical token absence to close newer credential work", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    snapshot = await journal.beginApproved(snapshot, input, () => nowMs);
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "absence_verified", resource: "tokens" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "token_intent", name: `${snapshot.reservation.envId}-containers-g1`, expiresAt: "2026-11-03T12:10:00Z" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "token_acknowledged", id: "token" });
    for (const resource of ["application", "worker"] as const) snapshot = await journal.append(snapshot, input.attemptId, { kind: "absence_verified", resource });
    await expect(journal.finish(snapshot, input.attemptId, "closed")).rejects.toMatchObject({ code: "invalid_journal" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "absence_verified", resource: "tokens" });
    expect((await journal.finish(snapshot, input.attemptId, "closed")).claim).toBeNull();
  });

  it.each(["remote_outcome_unknown", "journal_outcome_unknown", "interrupted_attempt"] as const)("durably quarantines %s without releasing or stealing the claim", async (reason) => {
    const before = await journal.reserve(reservation(), "provision");
    const snapshot = await other.quarantine(before, reason);
    expect(snapshot.status).toBe("uncertain");
    expect(snapshot.claim).toEqual(before.claim);
    expect(snapshot.reservation).toEqual(before.reservation);
    expect(snapshot.facts).toEqual([{ kind: "quarantined", reason }]);
    expect(await journal.read(before.reservation.accountId, before.reservation.companyId)).toEqual(snapshot);
    await expect(journal.reserve(before.reservation, "reuse")).rejects.toMatchObject({ code: "conflict" });
  });

  it("freezes a claim before ownership IDs are known and rejects the predecessor's late receipt", async () => {
    const before = await journal.reserve(reservation(), "provision");
    const snapshot = await other.quarantine(before, "interrupted_attempt");
    const late = { kind: "worker_acknowledged", workerTag: "tag", namespaceId: "namespace", versionId: "version" } as const;
    await expect(journal.append(before, "provision", late)).rejects.toMatchObject({ code: "conflict" });
    await expect(journal.append(snapshot, "provision", late)).rejects.toMatchObject({ code: "conflict" });
    await expect(journal.finish(snapshot, "provision", "ready")).rejects.toMatchObject({ code: "conflict" });
    expect(await journal.read(before.reservation.accountId, before.reservation.companyId)).toEqual(snapshot);
  });

  it("keeps consent burned and refuses new approvals, attempts, absence facts and closure after quarantine", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    snapshot = await journal.beginApproved(snapshot, input, () => nowMs);
    const before = structuredClone(snapshot);
    snapshot = await journal.quarantine(snapshot, "remote_outcome_unknown");
    expect(snapshot.burnedInteractionIds).toEqual([pin.interactionId]);
    expect(snapshot.approval).toEqual(before.approval);
    for (const resource of ["application", "worker", "tokens"] as const) {
      await expect(journal.append(snapshot, input.attemptId, { kind: "absence_verified", resource })).rejects.toMatchObject({ code: "conflict" });
    }
    await expect(journal.finish(snapshot, input.attemptId, "closed")).rejects.toMatchObject({ code: "conflict" });
    const next = approvalFixture(snapshot);
    await expect(journal.pinApproval(snapshot, next.input.operation, next.pin)).rejects.toMatchObject({ code: "conflict" });
    await expect(journal.beginApproved(snapshot, next.input, () => nowMs)).rejects.toMatchObject({ code: "approval_required" });
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it("retains token and application recovery obligations across quarantine and restart", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot, "deploy_container");
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    snapshot = await journal.beginApproved(snapshot, input, () => nowMs);
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "token_intent", name: `${snapshot.reservation.envId}-containers-g1`, expiresAt: "2026-11-03T12:10:00Z" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "token_acknowledged", id: "token" });
    snapshot = await journal.append(snapshot, input.attemptId, { kind: "application_intent" });
    const before = structuredClone(snapshot);
    snapshot = await journal.quarantine(snapshot, "remote_outcome_unknown");
    expect(snapshot.facts.slice(0, -1)).toEqual(before.facts);
    expect(snapshot.claim).toEqual(before.claim);
    expect(await new ContainerJournal(adapter(second)).read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it("does not treat a lost quarantine receipt as success or clear the committed obligation", async () => {
    const before = await journal.reserve(reservation(), "provision");
    const lost = new ContainerJournal({ ...db, execute: async (sql, params) => {
      await db.execute(sql, params);
      throw new Error("DATABASE_SECRET_CANARY");
    } });
    await expect(lost.quarantine(before, "journal_outcome_unknown")).rejects.toThrow("Container journal unavailable; no remote operation is authorized.");
    const stored = await other.read(before.reservation.accountId, before.reservation.companyId);
    expect(stored?.status).toBe("uncertain");
    expect(stored?.claim).toEqual(before.claim);
    expect(JSON.stringify(stored)).not.toContain("DATABASE_SECRET_CANARY");
  });

  it("leaves the original claim recoverable if the quarantine write was denied", async () => {
    const before = await journal.reserve(reservation(), "provision");
    const denied = new ContainerJournal({ ...db, execute: async () => { throw new Error("DATABASE_SECRET_CANARY"); } });
    await expect(denied.quarantine(before, "journal_outcome_unknown")).rejects.toMatchObject({ code: "unavailable" });
    expect(await other.read(before.reservation.accountId, before.reservation.companyId)).toEqual(before);
    const retry = await other.quarantine(before, "interrupted_attempt");
    expect(retry.status).toBe("uncertain");
  });

  it("does not let a stale quarantine snapshot overwrite a newer journal fact", async () => {
    const before = await journal.reserve(reservation(), "provision");
    const updated = await other.append(before, "provision", { kind: "worker_acknowledged", workerTag: "tag", namespaceId: "namespace", versionId: "version" });
    await expect(journal.quarantine(before, "interrupted_attempt")).rejects.toMatchObject({ code: "conflict" });
    expect(await journal.read(before.reservation.accountId, before.reservation.companyId)).toEqual(updated);
    expect((await journal.quarantine(updated, "interrupted_attempt")).facts).toHaveLength(2);
  });

  it("does not freeze an idle ready slot as an interrupted in-flight attempt", async () => {
    const snapshot = await ready(journal);
    await expect(journal.quarantine(snapshot, "interrupted_attempt")).rejects.toMatchObject({ code: "conflict" });
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  it("rejects invented uncertain status without its durable reason", async () => {
    const snapshot = await journal.reserve(reservation(), "provision");
    await first.query(`UPDATE ${table} SET document = jsonb_set(document, '{status}', '"uncertain"'::jsonb) WHERE account_id = $1`, [snapshot.reservation.accountId]);
    await expect(other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).rejects.toMatchObject({ code: "invalid_journal" });
  });

  it("reserves the final fact slot for irreversible quarantine", async () => {
    let snapshot = await ready(journal);
    const { pin, input } = approvalFixture(snapshot);
    snapshot = await journal.pinApproval(snapshot, input.operation, pin);
    snapshot = await journal.beginApproved(snapshot, input, () => nowMs);
    const facts = [...snapshot.facts, ...Array.from({ length: 510 }, () => ({ kind: "absence_verified", resource: "worker" }))];
    await first.query(`UPDATE ${table} SET document = jsonb_set(document, '{facts}', $1::jsonb) WHERE account_id = $2`, [JSON.stringify(facts), snapshot.reservation.accountId]);
    snapshot = (await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId))!;
    await expect(journal.append(snapshot, input.attemptId, { kind: "absence_verified", resource: "tokens" })).rejects.toMatchObject({ code: "invalid_journal" });
    const frozen = await journal.quarantine(snapshot, "interrupted_attempt");
    expect(frozen.facts).toHaveLength(512);
    expect(frozen.status).toBe("uncertain");
  });

  it("cannot append a caller-supplied quarantine marker through the ordinary fact API", async () => {
    const snapshot = await journal.reserve(reservation(), "provision");
    await expect(journal.append(snapshot, "provision", { kind: "quarantined", reason: "interrupted_attempt" })).rejects.toMatchObject({ code: "invalid_journal" });
    expect(await other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).toEqual(snapshot);
  });

  async function deploymentFixture() {
    let snapshot = await ready(journal);
    const approval = approvalFixture(snapshot, "deploy_container");
    snapshot = await journal.pinApproval(snapshot, approval.input.operation, approval.pin);
    const env = { ...snapshot.reservation, workerTag: "tag", namespaceId: "namespace" };
    const cleanup = { operatorUserId: "operator", cleanupIssueId: "cleanup-inbox" };
    const deploymentPolicy: ContainerDeploymentPolicy = {
      accountId: env.accountId, approvedImage: env.image, groupId: "b".repeat(32), egressCidrs: ["192.0.2.7/32"],
      pluginVersion: version, approval: policy, cleanup,
    };
    const source = { id: env.issueId, companyId: env.companyId, projectId: env.projectId, assigneeAgentId: env.ownerAgentId, status: "in_progress", assigneeUserId: null };
    const inbox = { id: cleanup.cleanupIssueId, companyId: env.companyId, status: "in_review", assigneeUserId: "operator", assigneeAgentId: null };
    const host = {
      ...approval.host,
      config: { get: vi.fn(async () => ({ accountId: env.accountId, allowedProjectIds: [env.projectId] })) },
      issues: {
        ...approval.host.issues,
        get: vi.fn(async (id: string) => id === env.issueId ? { ...source } : { ...inbox }),
        assertCheckoutOwner: vi.fn(async () => ({ issueId: env.issueId, assigneeAgentId: env.ownerAgentId, checkoutRunId: "run", status: "in_progress" })),
        requestConfirmation: vi.fn(async (issueId: string, input: Record<string, unknown>, companyId: string) => ({
          ...input, id: "notice", issueId, companyId, kind: "request_confirmation", status: "pending",
          requestedResolverPolicy: input.resolverPolicy, effectiveResolverPolicy: input.resolverPolicy,
        })),
      },
      access: { members: { list: vi.fn(async () => ["board-user", "operator"].map((principalId) => ({
        companyId: env.companyId, principalType: "user", principalId, status: "active", membershipRole: "member",
      }))) } },
    };
    const tokenId = "c".repeat(32);
    const json = (result: unknown) => Response.json({ success: true, result });
    const app = { id: "app", name: env.applicationName, account_id: env.accountId, scheduling_policy: "default", instances: 0, max_instances: 1,
      configuration: { image: env.image, instance_type: "lite" }, durable_objects: { namespace_id: env.namespaceId } };
    const responses: (Response | Error)[] = [
      json([{ id: deploymentPolicy.groupId, name: CONTAINERS_GROUP_NAME, is_selectable: true, scopes: ["com.cloudflare.api.account"] }]),
      json({ id: tokenId, value: "INTERNAL_SECRET_CANARY" }),
      json({ ...containerTokenRequest(env, deploymentPolicy.groupId, deploymentPolicy.egressCidrs, nowMs, "deploy"), id: tokenId, status: "active" }),
      json({ ...app, metadata: "INTERNAL_SECRET_CANARY" }), json(app), json({}), new Response(null, { status: 404 }),
    ];
    const observed: ContainerJournalSnapshot[] = [];
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      observed.push((await other.read(env.accountId, env.companyId))!);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("No live network in fixtures");
      return response;
    });
    const worker = {
      script: { id: env.workerName, tag: env.workerTag },
      version: { id: "version", resources: { bindings: [{ name: "SANDBOX", type: "durable_object_namespace", class_name: "ContainerSandbox", namespace_id: env.namespaceId }] } },
      namespace: { id: env.namespaceId, script: env.workerName, class: "ContainerSandbox" },
      deployments: { deployments: [{ strategy: "percentage", versions: [{ version_id: "version", percentage: 100 }] }] },
    };
    const workerFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/workers/scripts")) return json([worker.script]);
      if (url.endsWith("/versions/version")) return json(worker.version);
      if (url.endsWith("/deployments")) return json(worker.deployments);
      if (url.endsWith("/workers/durable_objects/namespaces?page=1&per_page=1000")) return Response.json({ success: true, result: [worker.namespace], result_info: { page: 1, per_page: 1000, count: 1, total_pages: 1, total_count: 1 } });
      throw new Error("No live network in Worker fixtures");
    });
    const deps = {
      host: host as unknown as Parameters<typeof deployContainerApplication>[0]["host"], journal,
      fetch: (url: string, init?: RequestInit) => url.includes("/workers/") ? workerFetch(url, init) : fetch(url, init),
      resolveBootstrap: vi.fn(async () => "BOOTSTRAP_SECRET_CANARY"), now: () => nowMs,
    };
    const run = { companyId: env.companyId, projectId: env.projectId, agentId: env.ownerAgentId, runId: "run" } as ToolRunContext;
    const input = { envId: env.envId, image: env.image };
    const invoke = () => deployContainerApplication(deps, run, input, deploymentPolicy);
    const restart = () => reconcileContainerAttempt(deps.host, other, { accountId: env.accountId, companyId: env.companyId, policy: cleanup });
    const read = () => other.read(env.accountId, env.companyId);
    return { deps, host, source, inbox, snapshot, deploymentPolicy, run, input, env, app, tokenId, responses, observed, fetch, worker, workerFetch, invoke, restart, read };
  }

  it.each(["tag", "version", "namespace", "deployment"])("refuses changed Worker %s evidence before token preflight/mint", async (part) => {
    const f = await deploymentFixture();
    if (part === "tag") f.worker.script.tag = "foreign";
    if (part === "version") f.worker.version.id = "foreign";
    if (part === "namespace") f.worker.namespace.script = "production";
    if (part === "deployment") f.worker.deployments.deployments[0]!.versions[0]!.percentage = 50;
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.read())?.status).toBe("cleanup_required");
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it("rechecks Worker evidence after mint and revokes without application creation on drift", async () => {
    const f = await deploymentFixture();
    const fetch = f.fetch.getMockImplementation()!;
    let calls = 0;
    f.fetch.mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (++calls === 3) f.worker.script.tag = "recreated";
      return response;
    });
    f.responses.splice(3, 2);
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET", "DELETE", "GET"]);
    expect((await f.read())?.facts).toContainEqual({ kind: "token_revoked", id: f.tokenId });
    expect((await f.read())?.facts.some((fact) => fact.kind === "application_intent")).toBe(false);
    expect((await f.read())?.status).toBe("cleanup_required");
  });

  it("integrates approval burn, write-ahead mint/create/revoke, read-back and secret-free live receipt", async () => {
    const f = await deploymentFixture();
    const result = await f.invoke();
    expect(result).toEqual({ envId: f.env.envId, applicationId: "app", expiresAt: f.env.expiresAt });
    expect(f.observed[1]!.facts.at(-1)?.kind).toBe("token_intent");
    expect(f.observed[3]!.facts.at(-1)?.kind).toBe("application_intent");
    expect(f.observed[5]!.facts.at(-1)).toEqual({ kind: "token_revocation_intent", id: f.tokenId });
    expect(f.observed.every((snapshot) => snapshot.claim?.operation === "deploy_container" && snapshot.burnedInteractionIds.length === 1)).toBe(true);
    expect(await f.read()).toMatchObject({ status: "live", claim: null });
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
    expect(JSON.stringify({ result, journal: await f.read() })).not.toMatch(/INTERNAL_SECRET_CANARY|BOOTSTRAP_SECRET_CANARY/);
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(7);
  });

  it.each(["closed-inbox", "wrong-owner", "foreign-env", "foreign-image", "extra-input", "wrong-company", "terminal-issue", "wrong-checkout"])("refuses %s before credential resolution", async (stage) => {
    const f = await deploymentFixture();
    if (stage === "closed-inbox") f.inbox.status = "done";
    if (stage === "wrong-owner") f.inbox.assigneeUserId = "foreign";
    if (stage === "foreign-env") f.input.envId = "pct-abcdef12-654321";
    if (stage === "foreign-image") f.input.image = `docker.io/cloudflare/sandbox@sha256:${"f".repeat(64)}`;
    if (stage === "extra-input") Object.assign(f.input, { approved: true });
    if (stage === "wrong-company") f.run.companyId = "foreign";
    if (stage === "terminal-issue") f.source.status = "done";
    if (stage === "wrong-checkout") f.host.issues.assertCheckoutOwner.mockResolvedValue({ issueId: f.env.issueId, assigneeAgentId: "foreign", checkoutRunId: "run", status: "in_progress" });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.deps.resolveBootstrap).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.read()).toEqual(f.snapshot);
  });

  it("allows exactly one concurrent approved deployment with two database connections", async () => {
    const f = await deploymentFixture();
    const results = await Promise.allSettled([f.invoke(), deployContainerApplication({ ...f.deps, journal: other }, f.run, f.input, f.deploymentPolicy)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect((await f.read())?.status).toBe("live");
  });

  it.each(["mint", "create"])("freezes unknown %s and retries only operator notice on restart", async (stage) => {
    const f = await deploymentFixture();
    const index = stage === "mint" ? 1 : 3;
    f.responses[index] = new Error("BOOTSTRAP_SECRET_CANARY INTERNAL_SECRET_CANARY");
    f.host.issues.requestConfirmation.mockRejectedValueOnce(new Error("INTERNAL_SECRET_CANARY"));
    await expect(f.invoke()).rejects.toMatchObject({ code: "notice_unverified" });
    expect(f.fetch).toHaveBeenCalledTimes(index + 1);
    const frozen = await f.read();
    expect(frozen?.status).toBe("uncertain");
    await expect(f.restart()).resolves.toEqual({ status: "quarantined" });
    expect(await f.read()).toEqual(frozen);
    expect(f.fetch).toHaveBeenCalledTimes(index + 1);
    const firstNotice = f.host.issues.requestConfirmation.mock.calls[0]![1];
    expect(f.host.issues.requestConfirmation.mock.calls[1]![1]).toEqual(firstNotice);
    expect(JSON.stringify({ journal: frozen, notice: firstNotice })).not.toMatch(/INTERNAL_SECRET_CANARY|BOOTSTRAP_SECRET_CANARY/);
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(index + 1);
  });

  it.each(["mint", "create"])("treats a malformed successful %s response as unknown, not a replay opportunity", async (stage) => {
    const f = await deploymentFixture();
    const index = stage === "mint" ? 1 : 3;
    f.responses[index] = Response.json({ success: true, result: { metadata: "INTERNAL_SECRET_CANARY" } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.fetch).toHaveBeenCalledTimes(index + 1);
    expect((await f.read())?.status).toBe("uncertain");
  });

  it.each(["before", "after"])("does not dispatch a create after %s-commit token-intent failure", async (when) => {
    const f = await deploymentFixture();
    let failed = false;
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const encoded = params?.[0];
      if (!failed && typeof encoded === "string" && encoded.includes('"kind":"token_intent"')) {
        failed = true;
        if (when === "after") await db.execute(sql, params);
        throw new Error("DATABASE_SECRET_CANARY");
      }
      return db.execute(sql, params);
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await f.read())?.status).toBe("uncertain");
  });

  it.each(["token_acknowledged", "application_acknowledged"])("freezes a lost %s receipt without further remote calls", async (kind) => {
    const f = await deploymentFixture();
    let failed = false;
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const encoded = params?.[0];
      const result = await db.execute(sql, params);
      if (!failed && typeof encoded === "string" && encoded.includes(`"kind":"${kind}"`)) {
        failed = true;
        throw new Error("DATABASE_SECRET_CANARY");
      }
      return result;
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.fetch).toHaveBeenCalledTimes(kind === "token_acknowledged" ? 2 : 4);
    expect((await f.read())?.facts.some((fact) => fact.kind === kind)).toBe(true);
    expect((await f.read())?.status).toBe("uncertain");
  });

  it("does not treat a lost approval-burn receipt as permission to mint", async () => {
    const f = await deploymentFixture();
    let failed = false;
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const result = await db.execute(sql, params);
      if (!failed) { failed = true; throw new Error("DATABASE_SECRET_CANARY"); }
      return result;
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.deps.resolveBootstrap).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.read())?.burnedInteractionIds).toHaveLength(1);
  });

  it("does not resolve credentials from a claim whose caller became terminal during approval", async () => {
    const f = await deploymentFixture();
    const audit = f.host.authorization.audit.search.getMockImplementation()!;
    f.host.authorization.audit.search.mockImplementationOnce(async () => {
      f.source.status = "done";
      return audit();
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect((await f.read())?.burnedInteractionIds).toHaveLength(1);
    expect((await f.read())?.claim?.operation).toBe("deploy_container");
    expect(f.deps.resolveBootstrap).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rechecks the claim after secret resolution and denies a predecessor frozen by restart", async () => {
    const f = await deploymentFixture();
    f.deps.resolveBootstrap.mockImplementationOnce(async () => {
      await f.restart();
      return "BOOTSTRAP_SECRET_CANARY";
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "journal_unverified" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.read())?.status).toBe("uncertain");
  });

  it("cannot progress after a restart observer freezes a still-pending provider mint", async () => {
    const f = await deploymentFixture();
    const fetch = f.fetch.getMockImplementation()!;
    let calls = 0;
    f.fetch.mockImplementation(async (...args) => {
      if (++calls === 2) await f.restart();
      return fetch(...args);
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect((await f.read())?.status).toBe("uncertain");
    expect((await f.read())?.facts.some((fact) => fact.kind === "token_acknowledged")).toBe(false);
  });

  it.each(["mint", "token-read", "create"])("stops at first 401 during %s without relabeling it as unknown create", async (stage) => {
    const f = await deploymentFixture();
    const index = ["mint", "token-read", "create"].indexOf(stage) + 1;
    f.responses[index] = new Response("INTERNAL_SECRET_CANARY", { status: 401 });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(index + 1);
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
    expect((await f.read())?.status).toBe("cleanup_required");
    expect((await f.read())?.claim?.operation).toBe("deploy_container");
  });

  it("keeps an acknowledged cap mismatch as an ordinary cleanup obligation, not unknown-create waiver", async () => {
    const f = await deploymentFixture();
    f.responses[3] = Response.json({ success: true, result: { ...f.app, max_instances: 2 } });
    f.responses.splice(4, 1);
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(6);
    expect((await f.read())?.facts).toContainEqual({ kind: "application_acknowledged", id: "app" });
    expect((await f.read())?.facts).toContainEqual({ kind: "token_revoked", id: f.tokenId });
    expect((await f.read())?.status).toBe("cleanup_required");
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it("allows private revocation after the issue closes but does not report a live success", async () => {
    const f = await deploymentFixture();
    const fetch = f.fetch.getMockImplementation()!;
    let calls = 0;
    f.fetch.mockImplementation(async (...args) => {
      if (++calls === 5) f.source.status = "done";
      return fetch(...args);
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect((await f.read())?.facts).toContainEqual({ kind: "token_revoked", id: f.tokenId });
    expect((await f.read())?.claim).not.toBeNull();
  });

  it.each([2, 3])("revokes a known token when local authorization refuses after HTTP call %s", async (stopAfter) => {
    const f = await deploymentFixture();
    f.responses.splice(stopAfter, 5 - stopAfter);
    const fetch = f.fetch.getMockImplementation()!;
    let calls = 0;
    f.fetch.mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (++calls === stopAfter) f.source.status = "done";
      return response;
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(stopAfter + 2);
    expect((await f.read())?.facts).toContainEqual({ kind: "token_revoked", id: f.tokenId });
    expect((await f.read())?.status).toBe("cleanup_required");
    expect(f.fetch.mock.calls.some(([, init]) => init?.method === "POST" && typeof init.body === "string" && init.body.includes('"scheduling_policy"'))).toBe(false);
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it("rechecks the verified token expiry after the asynchronous application-intent receipt", async () => {
    const f = await deploymentFixture();
    let clock = nowMs;
    f.deps.now = () => clock;
    f.responses.splice(3, 2);
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const result = await db.execute(sql, params);
      if (typeof params?.[0] === "string" && JSON.parse(params[0]).facts.at(-1)?.kind === "application_intent") clock = nowMs + 300000;
      return result;
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET", "DELETE", "GET"]);
    expect((await f.read())?.facts).toContainEqual({ kind: "token_revoked", id: f.tokenId });
    expect((await f.read())?.status).toBe("cleanup_required");
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it.each([300000, 0])("refuses success when the final live receipt crosses expiry minus %s", async (lead) => {
    const f = await deploymentFixture();
    let clock = nowMs;
    f.deps.now = () => clock;
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const result = await db.execute(sql, params);
      if (typeof params?.[0] === "string" && JSON.parse(params[0]).status === "live") clock = Date.parse(f.env.expiresAt) - lead;
      return result;
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(await f.read()).toMatchObject({ status: "live", claim: null });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it("does not dispatch token revocation after its intent write fails", async () => {
    const f = await deploymentFixture();
    let failed = false;
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const encoded = params?.[0];
      if (!failed && typeof encoded === "string" && encoded.includes('"kind":"token_revocation_intent"')) {
        failed = true;
        throw new Error("DATABASE_SECRET_CANARY");
      }
      return db.execute(sql, params);
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.fetch).toHaveBeenCalledTimes(5);
    expect((await f.read())?.facts).not.toContainEqual({ kind: "token_revoked", id: f.tokenId });
    expect((await f.read())?.status).toBe("uncertain");
  });

  it("does not report quarantine success on a lost freeze receipt; restart retries delivery only", async () => {
    const f = await deploymentFixture();
    f.responses[3] = new Error("INTERNAL_SECRET_CANARY");
    let failed = false;
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const result = await db.execute(sql, params);
      if (!failed && typeof params?.[0] === "string" && params[0].includes('"kind":"quarantined"')) {
        failed = true;
        throw new Error("DATABASE_SECRET_CANARY");
      }
      return result;
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "journal_unverified" });
    expect((await f.read())?.status).toBe("uncertain");
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
    await expect(f.restart()).resolves.toEqual({ status: "quarantined" });
    expect(f.host.issues.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it("does not return success after a lost live-commit receipt or replay its completed create", async () => {
    const f = await deploymentFixture();
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      const result = await db.execute(sql, params);
      if (typeof params?.[0] === "string" && JSON.parse(params[0]).status === "live") throw new Error("DATABASE_SECRET_CANARY");
      return result;
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "journal_unverified" });
    expect(await f.read()).toMatchObject({ status: "live", claim: null });
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(7);
    // A live unclaimed record remains for the ordinary cleanup scheduler, not
    // for ambiguous-create replay or release of this retained account slot.
    await expect(f.restart()).resolves.toEqual({ status: "idle" });
  });

  it("does not apply the unknown-create exception to a definitive application 403", async () => {
    const f = await deploymentFixture();
    f.responses[3] = new Response("INTERNAL_SECRET_CANARY", { status: 403 });
    f.responses.splice(4, 1);
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(6);
    expect((await f.read())?.facts).toContainEqual({ kind: "token_revoked", id: f.tokenId });
    expect((await f.read())?.status).toBe("cleanup_required");
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it.each([408, 429, 500])("treats a create HTTP %s as an unknown outcome and never dispatches finally revocation", async (status) => {
    const f = await deploymentFixture();
    f.responses[3] = new Response("INTERNAL_SECRET_CANARY", { status });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect((await f.read())?.status).toBe("uncertain");
  });

  it.each([401, 403])("retains HTTP %s as ordinary cleanup across restart, not the unknown-create exception", async (status) => {
    const f = await deploymentFixture();
    f.responses[3] = new Response("INTERNAL_SECRET_CANARY", { status });
    if (status === 403) f.responses.splice(4, 1);
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    const failed = await f.read();
    expect(failed?.status).toBe("cleanup_required");
    await expect(f.restart()).resolves.toEqual({ status: "cleanup_required" });
    expect(await f.read()).toEqual(failed);
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
    await expect(f.invoke()).rejects.toMatchObject({ code: "failed" });
    expect(f.fetch).toHaveBeenCalledTimes(status === 401 ? 4 : 6);
  });

  it.each(["before", "after"])("does not dispatch after a %s-commit ordinary-failure receipt loss", async (when) => {
    const f = await deploymentFixture();
    f.responses[3] = new Response(null, { status: 401 });
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      if (typeof params?.[0] === "string" && JSON.parse(params[0]).status === "cleanup_required") {
        if (when === "after") await db.execute(sql, params);
        throw new Error("DATABASE_SECRET_CANARY");
      }
      return db.execute(sql, params);
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "journal_unverified" });
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
    if (when === "after") {
      await expect(f.restart()).resolves.toEqual({ status: "cleanup_required" });
      expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
    }
  });

  it("keeps ordinary cleanup exclusion and refuses quarantine, stale appends or premature finish", async () => {
    const f = await deploymentFixture();
    const claimed = await journal.beginApproved(f.snapshot, {
      attemptId: "ordinary-failure", operation: "deploy_container", host: f.deps.host, pluginVersion: version, policy,
    }, () => nowMs);
    const failed = await journal.requireCleanup(claimed, "ordinary-failure");
    expect(failed).toEqual({ ...claimed, revision: claimed.revision + 1, status: "cleanup_required" });
    await expect(other.quarantine(failed, "interrupted_attempt")).rejects.toMatchObject({ code: "conflict" });
    await expect(other.finish(failed, "ordinary-failure", "live")).rejects.toMatchObject({ code: "conflict" });
    await expect(other.append(failed, "ordinary-failure", { kind: "application_intent" })).rejects.toMatchObject({ code: "conflict" });
    await expect(other.append(claimed, "ordinary-failure", { kind: "application_intent" })).rejects.toMatchObject({ code: "conflict" });
    expect(await f.read()).toEqual(failed);
    await expect(f.restart()).resolves.toEqual({ status: "cleanup_required" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])("does not create after a %s-commit application-intent receipt loss", async (when) => {
    const f = await deploymentFixture();
    let failed = false;
    f.deps.journal = new ContainerJournal({ ...db, execute: async (sql, params) => {
      if (!failed && typeof params?.[0] === "string" && JSON.parse(params[0]).facts.at(-1)?.kind === "application_intent") {
        failed = true;
        if (when === "after") await db.execute(sql, params);
        throw new Error("DATABASE_SECRET_CANARY");
      }
      return db.execute(sql, params);
    } });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect((await f.read())?.status).toBe("uncertain");
  });

  it("does not progress after a create reply arrives behind a restart freeze", async () => {
    const f = await deploymentFixture();
    const fetch = f.fetch.getMockImplementation()!;
    let calls = 0;
    f.fetch.mockImplementation(async (...args) => {
      if (++calls === 4) await f.restart();
      return fetch(...args);
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "quarantined" });
    expect(f.fetch).toHaveBeenCalledTimes(4);
    const frozen = await f.read();
    expect(frozen?.status).toBe("uncertain");
    expect(frozen?.facts.some((fact) => fact.kind === "application_acknowledged")).toBe(false);
    const notice = f.host.issues.requestConfirmation.mock.calls[0]![1];
    expect(JSON.stringify({ frozen, notice })).not.toMatch(/INTERNAL_SECRET_CANARY|BOOTSTRAP_SECRET_CANARY/);
  });

  it("does not quarantine or post notices for an idle ready or live slot on startup", async () => {
    const f = await deploymentFixture();
    await expect(f.restart()).resolves.toEqual({ status: "idle" });
    await f.invoke();
    await expect(f.restart()).resolves.toEqual({ status: "idle" });
    expect(f.host.issues.requestConfirmation).not.toHaveBeenCalled();
  });

  it("rejects corrupt stored documents rather than repairing them permissively", async () => {
    const snapshot = await journal.reserve(reservation(), "provision");
    await first.query(`UPDATE ${table} SET document = jsonb_set(document, '{facts}', 'null'::jsonb) WHERE account_id = $1`, [snapshot.reservation.accountId]);
    await expect(other.read(snapshot.reservation.accountId, snapshot.reservation.companyId)).rejects.toMatchObject({ code: "invalid_journal" });
  });
});

describe("isolated SQL fixture connection guard", () => {
  it.each(["?host=remote.invalid", "?hostaddr=192.0.2.1", "?port=5433", "#ignored", "?dbname=another"])("rejects connection overrides before constructing a client: %s", (suffix) => {
    expect(() => assertTestDatabaseUrl(`postgres://fixture@127.0.0.1:5432/cf_broker_test${suffix}`)).toThrow();
  });
});

describe("container journal fail-closed transport boundary", () => {
  function unavailableDb(count: unknown): PluginContext["db"] {
    return { namespace: CONTAINER_DATABASE_NAMESPACE, query: vi.fn(), execute: vi.fn(async () => count as { rowCount: number }) };
  }

  it.each([undefined, null, {}, { rowCount: -1 }, { rowCount: 2 }, { rowCount: "1" }, { rowCount: NaN }])("does not treat a malformed write receipt as authorization: %j", async (count) => {
    await expect(new ContainerJournal(unavailableDb(count)).reserve(reservation(), "attempt")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("fails closed when the database namespace is absent or different", () => {
    expect(() => new ContainerJournal({ ...unavailableDb({ rowCount: 1 }), namespace: "public" })).toThrow(ContainerJournalError);
  });

  it("never falls back to SDK state after a database capability denial", async () => {
    const db = unavailableDb({ rowCount: 1 });
    db.execute = vi.fn(async () => { throw new Error("DATABASE_SECRET_CANARY"); });
    await expect(new ContainerJournal(db).reserve(reservation(), "attempt")).rejects.toThrow("Container journal unavailable; no remote operation is authorized.");
  });

  it("rejects arbitrary fields and credential-bearing metadata before persistence", async () => {
    const db = unavailableDb({ rowCount: 1 });
    await expect(new ContainerJournal(db).reserve({ ...reservation(), token: "MINT_SECRET_CANARY" } as ContainerReservation, "attempt")).rejects.toMatchObject({ code: "invalid_journal" });
    expect(db.execute).not.toHaveBeenCalled();
  });
});
