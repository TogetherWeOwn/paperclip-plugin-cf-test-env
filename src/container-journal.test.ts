import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { containerApprovalDigest, type ContainerApprovalPin, type ContainerApprovalPolicy } from "./container-approval.js";
import { CONTAINER_DATABASE_NAMESPACE, ContainerJournal, ContainerJournalError, type ContainerJournalSnapshot, type ContainerReservation } from "./container-journal.js";
import type { ContainerIdentity, ContainerOperation } from "./container-contract.js";

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
