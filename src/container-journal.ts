import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readContainerApproval, type ContainerApprovalPin, type ContainerApprovalPolicy } from "./container-approval.js";
import { assertContainerActive, assertContainerIdentity, type ContainerIdentity, type ContainerOperation } from "./container-contract.js";

// The host derives this from the stable plugin key; migrations use the same name.
export const CONTAINER_DATABASE_NAMESPACE = "plugin_togetherweown_cf_test_env_4f5f3ae4ea";
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const MAX_FACTS = 512;
const MAX_APPROVALS = 64;

type Database = PluginContext["db"];
type ApprovalHost = Pick<PluginContext, "issues" | "access" | "authorization">;
export type ContainerReservation = Omit<ContainerIdentity, "workerTag" | "namespaceId" | "applicationId">;
type Operation = "provision_container" | ContainerOperation;
type Status = "reserved" | "ready" | "live" | "uncertain" | "closed";
const quarantineReasons = ["remote_outcome_unknown", "journal_outcome_unknown", "interrupted_attempt"] as const;
export type ContainerQuarantineReason = typeof quarantineReasons[number];

export type ContainerJournalFact =
  | { kind: "worker_acknowledged"; workerTag: string; namespaceId: string; versionId: string }
  | { kind: "application_intent" }
  | { kind: "application_acknowledged"; id: string }
  | { kind: "token_intent"; name: string; expiresAt: string }
  | { kind: "token_acknowledged"; id: string }
  | { kind: "token_revoked"; id: string }
  | { kind: "absence_verified"; resource: "application" | "worker" | "tokens" }
  | { kind: "quarantined"; reason: ContainerQuarantineReason };

interface JournalDocument {
  reservation: ContainerReservation;
  status: Status;
  facts: ContainerJournalFact[];
  claim: { id: string; operation: Operation } | null;
  approval: { operation: ContainerOperation; pin: ContainerApprovalPin } | null;
  burnedInteractionIds: string[];
}

export interface ContainerJournalSnapshot extends JournalDocument {
  revision: number;
}

export class ContainerJournalError extends Error {
  constructor(readonly code: "unavailable" | "invalid_journal" | "conflict" | "approval_required") {
    super({
      unavailable: "Container journal unavailable; no remote operation is authorized.",
      invalid_journal: "Container journal could not be verified; recovery is required.",
      conflict: "Container journal changed or capacity is reserved; no remote operation is authorized.",
      approval_required: "Current unconsumed container approval is required.",
    }[code]);
    this.name = "ContainerJournalError";
  }
}

function exact(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ContainerJournalError("invalid_journal");
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => d.get || d.set)) throw new ContainerJournalError("invalid_journal");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertReservation(value: unknown): asserts value is ContainerReservation {
  exact(value, ["accountId", "companyId", "issueId", "projectId", "ownerAgentId", "envId", "generation", "workerName", "applicationName", "image", "createdAt", "expiresAt"]);
  try {
    // Placeholders are only for checking the common fields, never persisted or
    // used in an API path. Namespace/tag are not known before Worker upload.
    assertContainerIdentity({ ...value, workerTag: "unassigned", namespaceId: "unassigned" } as ContainerIdentity);
  } catch { throw new ContainerJournalError("invalid_journal"); }
}

function assertPin(value: unknown): asserts value is ContainerApprovalPin {
  exact(value, ["interactionId", "digest", "sourceRunId", "createdAt", "expiresAt"], ["consumedAt"]);
  if (!validId(value.interactionId) || !validId(value.sourceRunId)
    || typeof value.digest !== "string" || !digestPattern.test(value.digest)
    || !validTime(value.createdAt) || !validTime(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    || Date.parse(value.expiresAt) - Date.parse(value.createdAt) > 600000
    || (value.consumedAt !== undefined && !validTime(value.consumedAt))) throw new ContainerJournalError("invalid_journal");
}

function assertFact(value: unknown, reservation: ContainerReservation): asserts value is ContainerJournalFact {
  if (!value || typeof value !== "object") throw new ContainerJournalError("invalid_journal");
  const kind = Object.getOwnPropertyDescriptor(value, "kind")?.value;
  switch (kind) {
    case "worker_acknowledged":
      exact(value, ["kind", "workerTag", "namespaceId", "versionId"]);
      if (![value.workerTag, value.namespaceId, value.versionId].every(validId)) throw new ContainerJournalError("invalid_journal");
      return;
    case "application_intent": exact(value, ["kind"]); return;
    case "application_acknowledged":
    case "token_acknowledged":
    case "token_revoked":
      exact(value, ["kind", "id"]);
      if (!validId(value.id)) throw new ContainerJournalError("invalid_journal");
      return;
    case "token_intent":
      exact(value, ["kind", "name", "expiresAt"]);
      if (value.name !== `${reservation.envId}-containers-g${reservation.generation}` || !validTime(value.expiresAt)) throw new ContainerJournalError("invalid_journal");
      return;
    case "quarantined":
      exact(value, ["kind", "reason"]);
      if (!quarantineReasons.some((reason) => reason === value.reason)) throw new ContainerJournalError("invalid_journal");
      return;
    case "absence_verified":
      exact(value, ["kind", "resource"]);
      if (!["application", "worker", "tokens"].includes(String(value.resource))) throw new ContainerJournalError("invalid_journal");
      return;
    default: throw new ContainerJournalError("invalid_journal");
  }
}

function credentialWork(facts: ContainerJournalFact[]) {
  let pending: { id: string | null } | null = null;
  let lastActivity = -1;
  let lastAbsence = -1;
  const acknowledged = new Set<string>();
  for (const [index, fact] of facts.entries()) {
    if (fact.kind === "token_intent") {
      if (pending) throw new ContainerJournalError("invalid_journal");
      pending = { id: null };
      lastActivity = index;
    } else if (fact.kind === "token_acknowledged") {
      if (!pending || pending.id !== null || acknowledged.has(fact.id)) throw new ContainerJournalError("invalid_journal");
      pending.id = fact.id;
      acknowledged.add(fact.id);
      lastActivity = index;
    } else if (fact.kind === "token_revoked") {
      if (!pending || pending.id !== fact.id) throw new ContainerJournalError("invalid_journal");
      pending = null;
    } else if (fact.kind === "absence_verified" && fact.resource === "tokens") {
      // Only a point-in-time inventory. An unknown mint must quarantine its
      // claim instead; quarantined journals cannot append absence or close.
      pending = null;
      lastAbsence = index;
    }
  }
  return { pending, terminalAbsence: lastAbsence > lastActivity };
}

function assertDocument(value: unknown): asserts value is JournalDocument {
  exact(value, ["reservation", "status", "facts", "claim", "approval", "burnedInteractionIds"]);
  assertReservation(value.reservation);
  if (!["reserved", "ready", "live", "uncertain", "closed"].includes(String(value.status))
    || !Array.isArray(value.facts) || value.facts.length > MAX_FACTS
    || !Array.isArray(value.burnedInteractionIds) || value.burnedInteractionIds.length > MAX_APPROVALS
    || !value.burnedInteractionIds.every(validId)
    || new Set(value.burnedInteractionIds).size !== value.burnedInteractionIds.length) throw new ContainerJournalError("invalid_journal");
  for (const fact of value.facts) assertFact(fact, value.reservation);
  const quarantines = value.facts.filter((fact) => fact.kind === "quarantined");
  if (value.status === "uncertain"
    ? quarantines.length !== 1 || value.facts.at(-1) !== quarantines[0] || value.claim === null
    : quarantines.length !== 0) throw new ContainerJournalError("invalid_journal");
  credentialWork(value.facts);
  if (value.claim !== null) {
    exact(value.claim, ["id", "operation"]);
    if (!validId(value.claim.id) || !["provision_container", "deploy_container", "teardown_container"].includes(String(value.claim.operation))) throw new ContainerJournalError("invalid_journal");
  }
  if (value.approval !== null) {
    exact(value.approval, ["operation", "pin"]);
    if (!["deploy_container", "teardown_container"].includes(String(value.approval.operation))) throw new ContainerJournalError("invalid_journal");
    assertPin(value.approval.pin);
    const burned = value.burnedInteractionIds.includes(value.approval.pin.interactionId);
    if (burned !== (value.approval.pin.consumedAt !== undefined)) throw new ContainerJournalError("invalid_journal");
  }
}

function document(snapshot: ContainerJournalSnapshot): JournalDocument {
  const { revision, ...doc } = snapshot;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) throw new ContainerJournalError("invalid_journal");
  assertDocument(doc);
  return structuredClone(doc);
}

function identity(snapshot: ContainerJournalSnapshot): ContainerIdentity {
  const workers = snapshot.facts.filter((fact) => fact.kind === "worker_acknowledged");
  const applications = snapshot.facts.filter((fact) => fact.kind === "application_acknowledged");
  if (workers.length !== 1 || applications.length > 1) throw new ContainerJournalError("invalid_journal");
  const worker = workers[0]!;
  return { ...snapshot.reservation, workerTag: worker.workerTag, namespaceId: worker.namespaceId,
    ...(applications[0] ? { applicationId: applications[0].id } : {}) };
}

export interface ContainerCleanupObligation {
  companyId: string;
  issueId: string;
  accountId: string;
  envId: string;
  generation: number;
  workerName: string;
  applicationName: string;
  expiresAt: string;
  reason: ContainerQuarantineReason;
  possibleUnknownCreates: ("worker_upload" | "application_create" | "token_mint")[];
  workerTags: string[];
  namespaceIds: string[];
  applicationIds: string[];
  tokenIds: string[];
}

/** Conservative inspection targets, not proof that any remote request has settled. */
export function containerCleanupObligation(snapshot: ContainerJournalSnapshot): ContainerCleanupObligation {
  const doc = document(snapshot);
  const quarantine = doc.facts.at(-1);
  if (doc.status !== "uncertain" || quarantine?.kind !== "quarantined") throw new ContainerJournalError("conflict");
  const { companyId, issueId, accountId, envId, generation, workerName, applicationName, expiresAt } = doc.reservation;
  const workers = doc.facts.filter((fact) => fact.kind === "worker_acknowledged");
  const applications = doc.facts.filter((fact) => fact.kind === "application_acknowledged");
  const tokens = doc.facts.filter((fact) => fact.kind === "token_acknowledged");
  const possibleUnknownCreates: ContainerCleanupObligation["possibleUnknownCreates"] = [];
  // Until dispatch integration exists a provisioning claim may have uploaded its
  // Worker even without an acknowledged ID. Include all earlier intents as well:
  // absence, expiry and revocation do not terminally settle an ambiguous create.
  if (doc.claim?.operation === "provision_container" || workers.length) possibleUnknownCreates.push("worker_upload");
  if (doc.facts.some((fact) => fact.kind === "application_intent")) possibleUnknownCreates.push("application_create");
  if (doc.facts.some((fact) => fact.kind === "token_intent")) possibleUnknownCreates.push("token_mint");
  return {
    companyId, issueId, accountId, envId, generation, workerName, applicationName, expiresAt,
    reason: quarantine.reason, possibleUnknownCreates,
    workerTags: [...new Set(workers.map((fact) => fact.workerTag))],
    namespaceIds: [...new Set(workers.map((fact) => fact.namespaceId))],
    applicationIds: [...new Set(applications.map((fact) => fact.id))],
    tokenIds: [...new Set(tokens.map((fact) => fact.id))],
  };
}

/**
 * Only ctx.db is used in production. Every successful mutation is one PostgreSQL
 * statement. No read/upsert emulation, expiring lease or automatic claim stealing.
 * Claims surviving a crash require a stale-writer-safe recovery protocol; they
 * are not silently cleared on startup. This module does not register any tools.
 */
export class ContainerJournal {
  #db: Database;
  #table: string;

  constructor(db: Database) {
    if (!db || db.namespace !== CONTAINER_DATABASE_NAMESPACE) throw new ContainerJournalError("unavailable");
    this.#db = db;
    this.#table = `"${CONTAINER_DATABASE_NAMESPACE}".container_slots`;
  }

  private async execute(sql: string, params: unknown[]): Promise<void> {
    let result: { rowCount: number };
    try { result = await this.#db.execute(sql, params); }
    catch { throw new ContainerJournalError("unavailable"); }
    if (result?.rowCount === 0) throw new ContainerJournalError("conflict");
    if (result?.rowCount !== 1) throw new ContainerJournalError("unavailable");
  }

  async reserve(reservation: ContainerReservation, attemptId: string): Promise<ContainerJournalSnapshot> {
    assertReservation(reservation);
    const doc: JournalDocument = { reservation, status: "reserved", facts: [], claim: { id: attemptId, operation: "provision_container" }, approval: null, burnedInteractionIds: [] };
    assertDocument(doc);
    // Serialize before awaiting, so mutation of the caller's object cannot change
    // the returned receipt or the immutable reservation sent to the database.
    const encoded = JSON.stringify(doc);
    await this.execute(`INSERT INTO ${this.#table} (account_id, company_id, env_id, revision, document)
      VALUES ($1, $2, $3, 1, $4::jsonb) ON CONFLICT (account_id) DO NOTHING`,
    [reservation.accountId, reservation.companyId, reservation.envId, encoded]);
    return { ...JSON.parse(encoded) as JournalDocument, revision: 1 };
  }

  async read(accountId: string, companyId: string): Promise<ContainerJournalSnapshot | null> {
    if (!/^[a-f0-9]{32}$/.test(accountId) || !validId(companyId)) throw new ContainerJournalError("invalid_journal");
    let rows: { account_id: string; company_id: string; env_id: string; revision: number; document: unknown }[];
    try {
      rows = await this.#db.query(`SELECT account_id, company_id, env_id, revision, document FROM ${this.#table}
        WHERE account_id = $1 AND company_id = $2`, [accountId, companyId]);
    } catch { throw new ContainerJournalError("unavailable"); }
    if (!Array.isArray(rows) || rows.length > 1) throw new ContainerJournalError("invalid_journal");
    if (!rows.length) return null;
    const row = rows[0]!;
    assertDocument(row.document);
    if (row.account_id !== accountId || row.company_id !== companyId || row.document.reservation.accountId !== accountId
      || row.document.reservation.companyId !== companyId || row.document.reservation.envId !== row.env_id) throw new ContainerJournalError("invalid_journal");
    const snapshot = { ...row.document, revision: row.revision };
    document(snapshot);
    return structuredClone(snapshot);
  }

  private async replace(before: ContainerJournalSnapshot, next: JournalDocument): Promise<ContainerJournalSnapshot> {
    const current = document(before);
    const revision = before.revision;
    assertDocument(next);
    if (JSON.stringify(current.reservation) !== JSON.stringify(next.reservation)) throw new ContainerJournalError("invalid_journal");
    const encoded = JSON.stringify(next);
    // Compare the complete old document as well as its revision. A fabricated or
    // caller-mutated receipt cannot replace immutable identities or old facts.
    await this.execute(`UPDATE ${this.#table} SET revision = revision + 1, document = $1::jsonb
      WHERE account_id = $2 AND company_id = $3 AND env_id = $4 AND revision = $5 AND document = $6::jsonb`,
    [encoded, current.reservation.accountId, current.reservation.companyId, current.reservation.envId, revision, JSON.stringify(current)]);
    return { ...JSON.parse(encoded) as JournalDocument, revision: revision + 1 };
  }

  /** Freeze only: an observer can quarantine an interrupted claim, never take it. */
  async quarantine(snapshot: ContainerJournalSnapshot, reason: ContainerQuarantineReason): Promise<ContainerJournalSnapshot> {
    const next = document(snapshot);
    if (!next.claim || next.status === "closed" || next.status === "uncertain") throw new ContainerJournalError("conflict");
    const fact: ContainerJournalFact = { kind: "quarantined", reason };
    assertFact(fact, next.reservation);
    next.status = "uncertain";
    next.facts.push(fact);
    return this.replace(snapshot, next);
  }

  async append(snapshot: ContainerJournalSnapshot, attemptId: string, fact: ContainerJournalFact): Promise<ContainerJournalSnapshot> {
    const next = document(snapshot);
    if (!next.claim || next.claim.id !== attemptId || next.status === "uncertain") throw new ContainerJournalError("conflict");
    assertFact(fact, next.reservation);
    // Always leave room to persist the irreversible quarantine marker.
    if (fact.kind === "quarantined" || next.facts.length >= MAX_FACTS - 1) throw new ContainerJournalError("invalid_journal");
    if (fact.kind.startsWith("token_") && (next.claim.operation === "provision_container"
      || next.approval?.operation !== next.claim.operation || !next.approval.pin.consumedAt
      || !next.burnedInteractionIds.includes(next.approval.pin.interactionId))) throw new ContainerJournalError("invalid_journal");
    if ((fact.kind === "worker_acknowledged" && (next.claim.operation !== "provision_container" || next.facts.some((f) => f.kind === "worker_acknowledged")))
      || (fact.kind === "application_intent" && (next.claim.operation !== "deploy_container" || next.facts.some((f) => f.kind === "application_intent")))
      || (fact.kind === "application_acknowledged" && (next.claim.operation !== "deploy_container" || !next.facts.some((f) => f.kind === "application_intent") || next.facts.some((f) => f.kind === "application_acknowledged")))
      || (fact.kind === "absence_verified" && next.claim.operation !== "teardown_container")) throw new ContainerJournalError("invalid_journal");
    next.facts.push(structuredClone(fact));
    return this.replace(snapshot, next);
  }

  /** End a known attempt only; ambiguous remote outcomes retain their claim. */
  async finish(snapshot: ContainerJournalSnapshot, attemptId: string, status: "ready" | "live" | "closed"): Promise<ContainerJournalSnapshot> {
    const next = document(snapshot);
    if (!next.claim || next.claim.id !== attemptId || next.status === "uncertain") throw new ContainerJournalError("conflict");
    const operation = next.claim.operation;
    if ((status === "ready" && operation !== "provision_container") || (status === "live" && operation !== "deploy_container")
      || (status === "closed" && operation !== "teardown_container") || !["ready", "live", "closed"].includes(status)) throw new ContainerJournalError("invalid_journal");
    if (status !== "closed") identity(snapshot);
    if (status === "live" && !next.facts.some((f) => f.kind === "application_acknowledged")) throw new ContainerJournalError("invalid_journal");
    const credentials = credentialWork(next.facts);
    if (credentials.pending || (status === "closed" && (!credentials.terminalAbsence
      || !["application", "worker"].every((resource) => next.facts.some((f) => f.kind === "absence_verified" && f.resource === resource))))) throw new ContainerJournalError("invalid_journal");
    next.status = status;
    next.claim = null;
    return this.replace(snapshot, next);
  }

  async pinApproval(snapshot: ContainerJournalSnapshot, operation: ContainerOperation, pin: ContainerApprovalPin): Promise<ContainerJournalSnapshot> {
    const next = document(snapshot);
    assertPin(pin);
    if (next.claim || next.status === "closed" || next.burnedInteractionIds.includes(pin.interactionId) || pin.consumedAt !== undefined) throw new ContainerJournalError("conflict");
    next.approval = { operation, pin: structuredClone(pin) };
    return this.replace(snapshot, next);
  }

  async beginApproved(snapshot: ContainerJournalSnapshot, input: {
    attemptId: string; operation: ContainerOperation; host: ApprovalHost; pluginVersion: string; policy: ContainerApprovalPolicy;
  }, now: () => number = Date.now): Promise<ContainerJournalSnapshot> {
    // Capture both the CAS baseline and operation inputs before any host await.
    const before = { ...document(snapshot), revision: snapshot.revision };
    const next = document(before);
    const { operation, attemptId, host, pluginVersion } = input;
    const policy = structuredClone(input.policy);
    const approval = next.approval;
    if (!validId(attemptId) || next.claim || next.status === "closed" || !approval || approval.operation !== operation
      || approval.pin.consumedAt !== undefined || next.burnedInteractionIds.includes(approval.pin.interactionId)) throw new ContainerJournalError("approval_required");
    if (operation === "deploy_container" && (next.status !== "ready" || next.facts.some((fact) => fact.kind === "application_intent" || fact.kind === "application_acknowledged"))) throw new ContainerJournalError("conflict");
    const env = identity(before);
    const assertCurrent = (time: number) => {
      if (!Number.isFinite(time) || time < Date.parse(approval.pin.createdAt) || time >= Date.parse(approval.pin.expiresAt)) throw new ContainerJournalError("approval_required");
      if (operation === "deploy_container") assertContainerActive(env, time);
    };
    await readContainerApproval(host, { env, operation, pin: approval.pin, pluginVersion, policy, nowMs: now() });
    const consumedMs = now();
    assertCurrent(consumedMs);
    approval.pin.consumedAt = new Date(consumedMs).toISOString();
    next.burnedInteractionIds.push(approval.pin.interactionId);
    next.claim = { id: attemptId, operation };
    // Consent burn and acquisition are one atomic statement. An unknown commit
    // result must not lead to a remote call or replay, even if later read-back
    // shows the claim. There is deliberately no resume/steal API here.
    const receipt = await this.replace(before, next);
    // A slow commit/reply cannot extend consent or the deployment window. Keep
    // the committed burn and claim on failure; this is not permission to replay.
    assertCurrent(now());
    return receipt;
  }
}
