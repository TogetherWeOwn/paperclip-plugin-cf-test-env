import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { containerCleanupObligation, type ContainerCleanupObligation, type ContainerJournal } from "./container-journal.js";

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
type CleanupHost = Pick<PluginContext, "issues" | "access">;

/** Reviewed host configuration, never tool input. No owner/default recipient. */
export interface ContainerCleanupPolicy {
  operatorUserId: string;
  cleanupIssueId: string;
}

export class ContainerCleanupNoticeError extends Error {
  constructor() {
    super("Container environment remains quarantined; operator cleanup notice is not verified.");
    this.name = "ContainerCleanupNoticeError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capturePolicy(value: ContainerCleanupPolicy): ContainerCleanupPolicy {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, "operatorUserId") || !Object.hasOwn(value, "cleanupIssueId")
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((d) => d.get || d.set)
    || typeof value.operatorUserId !== "string" || !idPattern.test(value.operatorUserId)
    || typeof value.cleanupIssueId !== "string" || !idPattern.test(value.cleanupIssueId)) throw new ContainerCleanupNoticeError();
  return { operatorUserId: value.operatorUserId, cleanupIssueId: value.cleanupIssueId };
}

function details(obligation: ContainerCleanupObligation): string {
  return [
    `Environment: \`${obligation.envId}\`, generation ${obligation.generation}. Source issue ID: \`${obligation.issueId}\`.`,
    `Account: \`${obligation.accountId}\`. Resource prefix: \`${obligation.envId}\`. Worker: \`${obligation.workerName}\`. Application: \`${obligation.applicationName}\`.`,
    `Original deadline: \`${obligation.expiresAt}\`. Quarantine reason: \`${obligation.reason}\`.`,
    `Create calls requiring inspection (conservative; may already have completed): ${obligation.possibleUnknownCreates.join(", ") || "none recorded"}.`,
    `Known Worker tags: ${obligation.workerTags.join(", ") || "unknown"}. Namespace IDs: ${obligation.namespaceIds.join(", ") || "unknown"}.`,
    `Known application IDs: ${obligation.applicationIds.join(", ") || "unknown"}. Token IDs (not values): ${obligation.tokenIds.join(", ") || "unknown"}.`,
    "Inspect and clean up only resources with independently verified ownership. A name prefix alone is not ownership. Remove owned container applications before the Worker/namespace; revoke related tokens. Never post credential values or provider diagnostics here.",
    "Unknown creates may commit later. Inventory absence, token expiry and a delayed recheck do not prove terminal settlement. Arrange human follow-up for late resources; automatic verified teardown by the original deadline is not claimed on this path.",
    "This environment, generation and account slot are permanently unavailable for reuse. Acknowledging this card neither releases the journal claim nor authorizes another create, credential change or deployment.",
  ].join("\n\n");
}

/**
 * Notification only: no Cloudflare, secrets, interaction response or journal-write
 * capability. The dedicated operator inbox outlives the env's possibly closed
 * source issue. Host idempotency retries delivery, never a remote create.
 */
export async function notifyContainerQuarantine(host: CleanupHost, journal: Pick<ContainerJournal, "read">, input: {
  accountId: string; companyId: string; policy: ContainerCleanupPolicy;
}): Promise<{ interactionId: string }> {
  try {
    const { accountId, companyId } = input;
    const policy = capturePolicy(input.policy);
    const snapshot = await journal.read(accountId, companyId);
    if (!snapshot) throw new ContainerCleanupNoticeError();
    const obligation = containerCleanupObligation(snapshot);
    if (obligation.accountId !== accountId || obligation.companyId !== companyId
      || policy.cleanupIssueId === obligation.issueId) throw new ContainerCleanupNoticeError();
    const digest = createHash("sha256").update(JSON.stringify(obligation)).digest("hex");
    const target = { type: "custom" as const, key: `cf-test-env:quarantine:${obligation.envId}`, revisionId: digest, revisionNumber: obligation.generation };
    const members = await host.access.members.list({ companyId });
    if (!Array.isArray(members) || members.filter((member) => member.companyId === companyId
      && member.principalType === "user" && member.principalId === policy.operatorUserId && member.status === "active"
      && typeof member.membershipRole === "string" && ["owner", "admin", "member"].includes(member.membershipRole)).length !== 1) throw new ContainerCleanupNoticeError();
    const assertInbox = async () => {
      const issue = await host.issues.get(policy.cleanupIssueId, companyId);
      if (!issue || issue.id !== policy.cleanupIssueId || issue.companyId !== companyId
        || !["todo", "in_progress", "in_review"].includes(issue.status)
        || issue.assigneeUserId !== policy.operatorUserId || issue.assigneeAgentId != null) throw new ContainerCleanupNoticeError();
    };
    await assertInbox();
    const prompt = `Confirm human cleanup follow-up for quarantined ${obligation.envId}, generation ${obligation.generation}?`;
    const detailsMarkdown = details(obligation);
    const interaction = await host.issues.requestConfirmation(policy.cleanupIssueId, {
      resolverPolicy: "human_only", addresseeUserId: policy.operatorUserId, continuationPolicy: "none",
      idempotencyKey: `container-quarantine:${digest}:${policy.operatorUserId}`,
      title: `Operator step: clean up quarantined ${obligation.envId}`,
      payload: { version: 1, prompt, detailsMarkdown, allowDeclineReason: true, supersedeOnUserComment: false, target },
    }, companyId);
    if (!record(interaction) || typeof interaction.id !== "string" || !idPattern.test(interaction.id)
      || interaction.companyId !== companyId || interaction.issueId !== policy.cleanupIssueId
      || interaction.kind !== "request_confirmation" || !["pending", "accepted", "rejected"].includes(interaction.status)
      || interaction.requestedResolverPolicy !== "human_only" || interaction.effectiveResolverPolicy !== "human_only"
      || interaction.addresseeUserId !== policy.operatorUserId || interaction.addresseeAgentId != null
      || !record(interaction.payload) || interaction.payload.version !== 1 || interaction.payload.prompt !== prompt
      || interaction.payload.detailsMarkdown !== detailsMarkdown || !record(interaction.payload.target)
      || interaction.payload.target.type !== target.type || interaction.payload.target.key !== target.key
      || interaction.payload.target.revisionId !== target.revisionId || interaction.payload.target.revisionNumber !== target.revisionNumber) throw new ContainerCleanupNoticeError();
    // A terminal/reassigned inbox during delivery is not a verified human path.
    await assertInbox();
    return { interactionId: interaction.id };
  } catch { throw new ContainerCleanupNoticeError(); }
}
