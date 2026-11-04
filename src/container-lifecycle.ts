import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { FetchImpl } from "./cloudflare.js";
import { authorizeContainerEnv } from "./container-access.js";
import { ContainerApiSession } from "./container-api.js";
import type { ContainerApprovalPolicy } from "./container-approval.js";
import { assertApprovedContainerImage, assertContainerActive, parseDeployContainerInput } from "./container-contract.js";
import { ContainerCredentialBroker, containerTokenRequest } from "./container-credentials.js";
import { containerJournalIdentity, type ContainerJournal, type ContainerJournalFact, type ContainerJournalSnapshot, type ContainerQuarantineReason } from "./container-journal.js";
import { assertContainerCleanupInbox, notifyContainerQuarantine, type ContainerCleanupPolicy } from "./container-quarantine.js";

type Host = Pick<PluginContext, "config" | "issues" | "access" | "authorization">;

export interface ContainerDeploymentPolicy {
  accountId: string;
  approvedImage: string;
  groupId: string;
  egressCidrs: string[];
  pluginVersion: string;
  approval: ContainerApprovalPolicy;
  cleanup: ContainerCleanupPolicy;
}

export class ContainerLifecycleError extends Error {
  constructor(readonly code: "failed" | "quarantined" | "journal_unverified" | "notice_unverified") {
    super({
      failed: "Container deployment failed; retained lifecycle state requires cleanup.",
      quarantined: "Container environment is permanently quarantined; operator cleanup notice verified.",
      journal_unverified: "Container lifecycle journal update could not be verified; retained state requires reconciliation.",
      notice_unverified: "Container environment is quarantined; operator notice requires retry.",
    }[code]);
    this.name = "ContainerLifecycleError";
  }
}

/** A fresh read permits freezing/notification only, never remote replay. */
async function freezeAndNotify(host: Pick<Host, "issues" | "access">, journal: ContainerJournal, expected: ContainerJournalSnapshot,
  reason: ContainerQuarantineReason, policy: ContainerCleanupPolicy): Promise<void> {
  let current: ContainerJournalSnapshot | null;
  try {
    current = await journal.read(expected.reservation.accountId, expected.reservation.companyId);
    if (!current || !isDeepStrictEqual(current.reservation, expected.reservation)
      || !current.claim || current.claim.id !== expected.claim?.id) throw new Error();
    if (current.status !== "uncertain") current = await journal.quarantine(current, reason);
  } catch { throw new ContainerLifecycleError("journal_unverified"); }
  try { await notifyContainerQuarantine(host, journal, { ...current.reservation, policy }); }
  catch { throw new ContainerLifecycleError("notice_unverified"); }
}

/**
 * Unregistered application leg, not a complete deploy tool. Worker upload/current
 * ownership fetching, trusted runtime/spend and ordinary teardown remain gates.
 * No caller-selected fetch/config/source/approval or resumable claim is exposed.
 */
export async function deployContainerApplication(deps: {
  host: Host; journal: ContainerJournal; fetch: FetchImpl; resolveBootstrap: () => Promise<string>; now?: () => number;
}, runContext: ToolRunContext, input: unknown, reviewedPolicy: ContainerDeploymentPolicy): Promise<{ envId: string; applicationId: string; expiresAt: string }> {
  let snapshot: ContainerJournalSnapshot;
  let policy: ContainerDeploymentPolicy;
  const { host, journal, fetch, resolveBootstrap } = deps;
  const now = deps.now ?? Date.now;
  const run = { ...runContext };
  try {
    policy = structuredClone(reviewedPolicy);
    const parsed = parseDeployContainerInput(input);
    const stored = await journal.read(policy.accountId, run.companyId);
    if (!stored || stored.status !== "ready" || stored.claim || stored.reservation.envId !== parsed.envId) throw new Error();
    snapshot = stored;
    const env = containerJournalIdentity(snapshot);
    assertApprovedContainerImage(parsed.image, policy.approvedImage);
    assertApprovedContainerImage(env.image, policy.approvedImage);
    containerTokenRequest(env, policy.groupId, policy.egressCidrs, now(), "deploy");
    if (policy.cleanup.cleanupIssueId === env.issueId) throw new Error();
    await authorizeContainerEnv(host, run, env, now);
    await assertContainerCleanupInbox(host, env.companyId, policy.cleanup);
  } catch { throw new ContainerLifecycleError("failed"); }

  const attemptId = randomUUID();
  const beforeClaim = snapshot;
  try {
    snapshot = await journal.beginApproved(snapshot, {
      attemptId, operation: "deploy_container", host, pluginVersion: policy.pluginVersion, policy: policy.approval,
    }, now);
  } catch {
    // A lost acquisition receipt never permits a call, even if the burn committed.
    const expected = { ...beforeClaim, claim: { id: attemptId, operation: "deploy_container" as const } };
    let claimed: ContainerJournalSnapshot | null;
    try { claimed = await journal.read(policy.accountId, run.companyId); }
    catch { throw new ContainerLifecycleError("journal_unverified"); }
    if (claimed?.claim?.id === attemptId) {
      await freezeAndNotify(host, journal, expected, "journal_outcome_unknown", policy.cleanup);
      throw new ContainerLifecycleError("quarantined");
    }
    throw new ContainerLifecycleError("failed");
  }

  const env = containerJournalIdentity(snapshot);
  let pendingCreate = false;
  let journalUnknown = false;
  let closed = false;
  let tokenId: string | undefined;
  let revoking = false;
  const append = async (fact: ContainerJournalFact) => {
    try { snapshot = await journal.append(snapshot, attemptId, fact); }
    catch {
      journalUnknown = true;
      closed = true;
      throw new ContainerLifecycleError("journal_unverified");
    }
  };
  const assertClaim = async () => {
    const current = await journal.read(env.accountId, env.companyId);
    if (!current || current.status !== "ready" || current.claim?.id !== attemptId
      || !isDeepStrictEqual(current, snapshot)) throw new ContainerLifecycleError("failed");
  };
  const tokenBase = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/tokens`;
  const appBase = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/containers/applications`;
  const session = new ContainerApiSession(async (url, init) => {
    if (closed || pendingCreate) throw new ContainerLifecycleError("failed");
    const method = init?.method;
    const mint = url === tokenBase && method === "POST";
    const create = url === appBase && method === "POST";
    const revoke = tokenId !== undefined && url === `${tokenBase}/${tokenId}` && method === "DELETE";
    const revokeRead = revoking && url === `${tokenBase}/${tokenId}` && method === "GET";
    const tokenRead = tokenId !== undefined && url === `${tokenBase}/${tokenId}` && method === "GET";
    const app = snapshot.facts.find((fact) => fact.kind === "application_acknowledged");
    if (!(mint || create || revoke || tokenRead || revokeRead
      || (url === `${tokenBase}/permission_groups` && method === "GET")
      || (app?.kind === "application_acknowledged" && url === `${appBase}/${app.id}` && method === "GET"))) throw new ContainerLifecycleError("failed");
    // Revocation is this attempt's private finally path, not an expired manual
    // deploy capability: it must still run after the issue/TTL becomes terminal.
    if (!revoke && !revokeRead) await authorizeContainerEnv(host, run, env, now);
    await assertClaim();
    if (create) await append({ kind: "application_intent" });
    if (revoke) {
      await append({ kind: "token_revocation_intent", id: tokenId! });
      revoking = true;
    }
    if (closed) throw new ContainerLifecycleError("failed");
    if (!revoke && !revokeRead) assertContainerActive(env, now());
  });
  const guardedFetch: FetchImpl = async (url, init) => {
    // Only reached after all async guards and the broker's capability recheck.
    if (init?.method === "POST" && (url === tokenBase || url === appBase)) pendingCreate = true;
    const response = await fetch(url, init);
    // A definitive client refusal is not the accepted unknown-create residual.
    // Timeout/rate-limit/server responses and malformed successes stay unknown.
    if (pendingCreate && response.status >= 400 && response.status < 500
      && ![408, 425, 429].includes(response.status)) pendingCreate = false;
    return response;
  };

  try {
    await authorizeContainerEnv(host, run, env, now);
    await assertClaim();
    const bootstrap = await resolveBootstrap();
    // Secret resolution is asynchronous. A concurrent restart observer can freeze
    // this claim, so recheck before even the credential permission preflight.
    await assertClaim();
    const broker = new ContainerCredentialBroker(guardedFetch, bootstrap, env.accountId, session, now);
    const applicationId = await broker.withApplicationApi({
      env, groupId: policy.groupId, egressCidrs: policy.egressCidrs, purpose: "deploy",
      journal: {
        begin: (name, expiresAt) => append({ kind: "token_intent", name, expiresAt }),
        acknowledged: async (id) => {
          await append({ kind: "token_acknowledged", id });
          tokenId = id;
          pendingCreate = false;
        },
        revoked: (id) => append({ kind: "token_revoked", id }),
      },
    }, (api) => api.create(env, policy.approvedImage, async (id) => {
      await append({ kind: "application_acknowledged", id });
      pendingCreate = false;
    }));
    await authorizeContainerEnv(host, run, env, now);
    // This receipt is not cleanup proof and does not extend the original deadline.
    snapshot = await journal.finish(snapshot, attemptId, "live");
    assertContainerActive(env, now());
    return { envId: env.envId, applicationId, expiresAt: env.expiresAt };
  } catch {
    closed = true;
    if (pendingCreate || journalUnknown) {
      await freezeAndNotify(host, journal, snapshot, journalUnknown ? "journal_outcome_unknown" : "remote_outcome_unknown", policy.cleanup);
      throw new ContainerLifecycleError("quarantined");
    }
    // A verified live commit may outlast the deadline. Refuse success but retain
    // that unclaimed cleanup obligation; do not rewrite it or replay creation.
    if (snapshot.status === "live" && snapshot.claim === null) throw new ContainerLifecycleError("failed");
    // The awaited broker/finally path has settled without an unknown create.
    // Persist that distinction so startup cannot silently apply the residual to
    // a definitive refusal or an acknowledged-but-unsafe application.
    try { snapshot = await journal.requireCleanup(snapshot, attemptId); }
    catch { throw new ContainerLifecycleError("journal_unverified"); }
    throw new ContainerLifecycleError("failed");
  } finally { closed = true; }
}

/** Credential-free restart/notice retry. Never claims, replays, deletes or releases. */
export async function reconcileContainerAttempt(host: Pick<Host, "issues" | "access">, journal: ContainerJournal, input: {
  accountId: string; companyId: string; policy: ContainerCleanupPolicy;
}): Promise<{ status: "idle" | "quarantined" | "cleanup_required" }> {
  try {
    const { accountId, companyId } = input;
    const policy = structuredClone(input.policy);
    const snapshot = await journal.read(accountId, companyId);
    if (!snapshot?.claim) return { status: "idle" };
    if (snapshot.status === "cleanup_required") return { status: "cleanup_required" };
    await freezeAndNotify(host, journal, snapshot, "interrupted_attempt", policy);
    return { status: "quarantined" };
  } catch (error) {
    if (error instanceof ContainerLifecycleError) throw error;
    throw new ContainerLifecycleError("journal_unverified");
  }
}
