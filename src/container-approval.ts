import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertContainerIdentity, containerConsentKey, type ContainerIdentity, type ContainerOperation } from "./container-contract.js";

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const MAX_CONSENT_MS = 10 * 60 * 1000;

export class ContainerApprovalRefusal extends Error {
  constructor() {
    super("Independent, current container approval could not be verified.");
    this.name = "ContainerApprovalRefusal";
  }
}

export interface ContainerApprovalPolicy {
  /** Hash of the reviewed execution configuration, runtime artifact and limits. */
  policyDigest: string;
  /** Explicitly routed principals, not all members and not a default owner. */
  approverUserIds: string[];
}

export interface ContainerApprovalPin {
  interactionId: string;
  digest: string;
  sourceRunId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number {
  return value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
}

export function containerApprovalDigest(env: ContainerIdentity, operation: ContainerOperation, pluginVersion: string, policy: ContainerApprovalPolicy): string {
  if (!policy || !digestPattern.test(policy.policyDigest) || !Array.isArray(policy.approverUserIds)
    || !policy.approverUserIds.length || !policy.approverUserIds.every((id) => typeof id === "string" && idPattern.test(id))
    || new Set(policy.approverUserIds).size !== policy.approverUserIds.length) throw new ContainerApprovalRefusal();
  return createHash("sha256").update(JSON.stringify({
    operation: containerConsentKey(env, operation, pluginVersion),
    policy: policy.policyDigest,
    approvers: [...policy.approverUserIds].sort(),
  })).digest("hex");
}

function targetKey(env: ContainerIdentity, operation: ContainerOperation): string {
  return `cf-test-env:${operation}:${env.envId}`;
}

function matchingInteraction(value: unknown, env: ContainerIdentity, operation: ContainerOperation, pin: ContainerApprovalPin): value is Record<string, unknown> {
  if (!record(value) || value.id !== pin.interactionId || value.companyId !== env.companyId || value.issueId !== env.issueId
    || value.kind !== "request_confirmation" || value.sourceRunId !== pin.sourceRunId || value.createdByAgentId !== env.ownerAgentId
    || value.createdByUserId != null || value.addresseeAgentId != null
    || value.requestedResolverPolicy !== "human_only" || value.effectiveResolverPolicy !== "human_only"
    || timestamp(value.createdAt) !== timestamp(pin.createdAt) || !record(value.payload) || value.payload.version !== 1) return false;
  const target = value.payload.target;
  return record(target) && target.type === "custom" && target.key === targetKey(env, operation)
    && target.revisionId === pin.digest && target.revisionNumber === env.generation;
}

/** Pure evidence predicate. This does not consume consent or authorize an HTTP call. */
export function verifyContainerApproval(input: {
  env: ContainerIdentity; operation: ContainerOperation; pluginVersion: string; policy: ContainerApprovalPolicy;
  pin: ContainerApprovalPin; interaction: unknown; members: unknown; audit: unknown; nowMs: number;
}): void {
  const { env, operation, pluginVersion, policy, pin, interaction, members, audit, nowMs } = input;
  assertContainerIdentity(env);
  const digest = containerApprovalDigest(env, operation, pluginVersion, policy);
  const created = timestamp(pin.createdAt);
  const expires = timestamp(pin.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(created) || !Number.isFinite(expires) || created > nowMs
    || expires <= created || expires - created > MAX_CONSENT_MS || nowMs >= expires
    || pin.consumedAt !== undefined || !idPattern.test(pin.interactionId) || !idPattern.test(pin.sourceRunId)
    || pin.digest !== digest || !matchingInteraction(interaction, env, operation, pin)
    || interaction.status !== "accepted" || !record(interaction.result) || interaction.result.version !== 1 || interaction.result.outcome !== "accepted"
    || interaction.resolvedByAgentId != null || interaction.resolvedByRunId != null
    || typeof interaction.resolvedByUserId !== "string" || !policy.approverUserIds.includes(interaction.resolvedByUserId)
    || (interaction.addresseeUserId != null && interaction.addresseeUserId !== interaction.resolvedByUserId)) throw new ContainerApprovalRefusal();
  const resolved = timestamp(interaction.resolvedAt);
  if (!Number.isFinite(resolved) || resolved < created || resolved >= expires || resolved > nowMs) throw new ContainerApprovalRefusal();
  const resolver = interaction.resolvedByUserId;
  if (!Array.isArray(members) || members.filter((member) => record(member) && member.companyId === env.companyId
    && member.principalType === "user" && member.principalId === resolver && member.status === "active"
    && ["owner", "admin", "member"].includes(String(member.membershipRole))).length !== 1) throw new ContainerApprovalRefusal();
  // Plugin relays can attribute a user. Only positive host audit evidence with a
  // top-level board principal distinguishes that route; absence proves nothing.
  if (!Array.isArray(audit) || !audit.some((event) => record(event) && event.companyId === env.companyId
    && event.action === "issue.thread_interaction_accepted" && event.actorType === "user" && event.actorId === resolver
    && event.entityType === "issue" && event.entityId === env.issueId && timestamp(event.createdAt) >= resolved
    && timestamp(event.createdAt) <= nowMs && timestamp(event.createdAt) < expires && record(event.details)
    && event.details.interactionId === pin.interactionId && event.details.interactionKind === "request_confirmation"
    && event.details.interactionStatus === "accepted" && event.details.resolutionActorKind === "user"
    && event.details.effectiveResolverPolicy === "human_only")) throw new ContainerApprovalRefusal();
}

type ApprovalHost = Pick<PluginContext, "issues" | "access" | "authorization">;

/** Requires create/read, member-read and audit-read, never interaction respond. */
export async function requestContainerApproval(host: ApprovalHost, input: {
  env: ContainerIdentity; operation: ContainerOperation; pluginVersion: string; policy: ContainerApprovalPolicy; sourceRunId: string;
}, now: () => number = Date.now): Promise<ContainerApprovalPin> {
  const { env, operation, pluginVersion, policy, sourceRunId } = input;
  const nowMs = now();
  const digest = containerApprovalDigest(env, operation, pluginVersion, policy);
  if (!idPattern.test(sourceRunId) || !Number.isFinite(nowMs)) throw new ContainerApprovalRefusal();
  try {
    const interaction = await host.issues.requestConfirmation(env.issueId, {
      resolverPolicy: "human_only", sourceRunId, continuationPolicy: "wake_assignee",
      ...(policy.approverUserIds.length === 1 ? { addresseeUserId: policy.approverUserIds[0]! } : {}),
      idempotencyKey: `container:${digest}:${sourceRunId}`,
      title: `Board: ${operation} ${env.envId}`,
      payload: {
        version: 1, allowDeclineReason: true, prompt: `Approve ${operation} for ${env.envId}, generation ${env.generation}?`,
        detailsMarkdown: `Exact operation digest: \`${digest}\`. Consent expires ten minutes after creation. No other environment or operation is authorized.`,
        target: { type: "custom", key: targetKey(env, operation), revisionId: digest, revisionNumber: env.generation },
      },
    }, env.companyId, { authorAgentId: env.ownerAgentId });
    const created = timestamp(interaction.createdAt);
    const pin: ContainerApprovalPin = {
      interactionId: interaction.id, digest, sourceRunId,
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + MAX_CONSENT_MS).toISOString(),
    };
    const receivedAt = now();
    if (!idPattern.test(pin.interactionId) || !Number.isFinite(receivedAt) || receivedAt < nowMs
      || created > receivedAt || receivedAt >= created + MAX_CONSENT_MS
      || interaction.status !== "pending" || !matchingInteraction(interaction, env, operation, pin)) throw new ContainerApprovalRefusal();
    // The caller must persist this returned ID before accepting subsequent use.
    return pin;
  } catch { throw new ContainerApprovalRefusal(); }
}

export async function readContainerApproval(host: ApprovalHost, input: {
  env: ContainerIdentity; operation: ContainerOperation; pluginVersion: string; policy: ContainerApprovalPolicy; pin: ContainerApprovalPin; nowMs: number;
}): Promise<void> {
  try {
    const interactions = await host.issues.listInteractions(input.env.issueId, input.env.companyId);
    const matches = interactions.filter((interaction) => interaction.id === input.pin.interactionId);
    if (matches.length !== 1) throw new ContainerApprovalRefusal();
    const members = await host.access.members.list({ companyId: input.env.companyId });
    // Finding a positive matching event is sufficient; missing/truncated history
    // refuses instead of treating the end of a page as approval evidence.
    const audit = await host.authorization.audit.search({
      companyId: input.env.companyId, action: "issue.thread_interaction_accepted", actorType: "user",
      entityType: "issue", entityId: input.env.issueId, limit: 100, offset: 0,
    });
    verifyContainerApproval({ ...input, interaction: matches[0], members, audit });
  } catch { throw new ContainerApprovalRefusal(); }
}
