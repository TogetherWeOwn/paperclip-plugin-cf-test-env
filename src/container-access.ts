import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertContainerActive, assertContainerIdentity, type ContainerIdentity } from "./container-contract.js";

type AccessHost = Pick<PluginContext, "config" | "issues">;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

export class ContainerAccessRefusal extends Error {
  constructor() {
    super("Current container environment ownership and checkout could not be verified.");
    this.name = "ContainerAccessRefusal";
  }
}

export interface ContainerCaller {
  companyId: string;
  issueId: string;
  projectId: string;
  ownerAgentId: string;
  runId: string;
  accountId: string;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function policy(host: AccessHost, companyId: string): Promise<{ accountId: string; projectIds: string[] }> {
  const value = await host.config.get(companyId);
  if (!record(value) || typeof value.accountId !== "string" || !/^[a-f0-9]{32}$/.test(value.accountId)
    || !Array.isArray(value.allowedProjectIds) || !value.allowedProjectIds.length || !value.allowedProjectIds.every(validId)) throw new ContainerAccessRefusal();
  return { accountId: value.accountId, projectIds: [...value.allowedProjectIds] };
}

function matchingIssue(value: unknown, run: ToolRunContext, issueId: string, allowed: string[]): boolean {
  return record(value) && value.id === issueId && value.companyId === run.companyId
    && value.assigneeAgentId === run.agentId && value.assigneeUserId == null
    && value.status === "in_progress" && value.projectId === run.projectId && allowed.includes(run.projectId);
}

/**
 * Authenticate host context, not tool parameters. This is a current precondition,
 * not a reusable grant: call again inside the durable operation before secrets
 * or remote mutations. No secret/HTTP capability is needed for these checks.
 */
export async function authorizeContainerProvision(host: AccessHost, run: ToolRunContext, issueId: string): Promise<ContainerCaller> {
  try {
    if (!run || ![run.companyId, run.projectId, run.agentId, run.runId, issueId].every(validId)) throw new ContainerAccessRefusal();
    // Freeze the authenticated context across async host calls.
    const caller = { companyId: run.companyId, projectId: run.projectId, agentId: run.agentId, runId: run.runId };
    const before = await policy(host, caller.companyId);
    const issue = await host.issues.get(issueId, caller.companyId);
    if (!matchingIssue(issue, caller, issueId, before.projectIds)) throw new ContainerAccessRefusal();
    const ownership = await host.issues.assertCheckoutOwner({
      issueId, companyId: caller.companyId, actorAgentId: caller.agentId, actorRunId: caller.runId,
    });
    if (!ownership || ownership.issueId !== issueId || ownership.assigneeAgentId !== caller.agentId
      || ownership.checkoutRunId !== caller.runId || ownership.status !== "in_progress") throw new ContainerAccessRefusal();
    // Checkout can await host work. Assignment, terminal status or configuration
    // may have changed meanwhile; do not authorize from the first read alone.
    const current = await host.issues.get(issueId, caller.companyId);
    const after = await policy(host, caller.companyId);
    if (before.accountId !== after.accountId || !matchingIssue(current, caller, issueId, after.projectIds)) throw new ContainerAccessRefusal();
    return { companyId: caller.companyId, issueId, projectId: caller.projectId, ownerAgentId: caller.agentId, runId: caller.runId, accountId: after.accountId };
  } catch { throw new ContainerAccessRefusal(); }
}

/** Manual tool entry only. Internal deadline/terminal cleanup is a separate path. */
export async function authorizeContainerEnv(host: AccessHost, run: ToolRunContext, env: ContainerIdentity, now: () => number = Date.now): Promise<ContainerCaller> {
  try {
    assertContainerIdentity(env);
    assertContainerActive(env, now());
    if (!run || env.companyId !== run.companyId || env.projectId !== run.projectId || env.ownerAgentId !== run.agentId) throw new ContainerAccessRefusal();
    const expected = { companyId: env.companyId, issueId: env.issueId, projectId: env.projectId, ownerAgentId: env.ownerAgentId, accountId: env.accountId };
    const caller = await authorizeContainerProvision(host, run, env.issueId);
    if (caller.companyId !== expected.companyId || caller.issueId !== expected.issueId || caller.projectId !== expected.projectId
      || caller.ownerAgentId !== expected.ownerAgentId || caller.accountId !== expected.accountId) throw new ContainerAccessRefusal();
    assertContainerActive(env, now());
    return caller;
  } catch { throw new ContainerAccessRefusal(); }
}
