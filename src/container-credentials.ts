import type { FetchImpl } from "./cloudflare.js";
import { ContainerApiError, ContainerApiSession, ContainerApplicationApi } from "./container-api.js";
import { assertContainerActive, assertContainerIdentity, ContainerRefusal, type ContainerIdentity } from "./container-contract.js";
import { ACCOUNT_RESOURCE, buildTokenRequest, normalizeCidr, type TokenRequest } from "./scoping.js";

export const CONTAINERS_GROUP_NAME = "Workers Containers Write";
const TOKEN_TTL_SECONDS = 300;
const idPattern = /^[a-f0-9]{32}$/;

export class ContainerCredentialError extends Error {
  constructor(readonly code: "invalid_config" | "permission_unavailable" | "verification_failed" | "operation_failed" | "journal_failed" | "revocation_unverified") {
    super({
      invalid_config: "Container credential configuration is invalid.",
      permission_unavailable: "The configured account Containers permission is not selectable; no credential was minted.",
      verification_failed: "Internal container credential read-back failed verification.",
      operation_failed: "Container credential operation failed; recovery intent must be retained.",
      journal_failed: "Container credential journal update failed; recovery is required.",
      revocation_unverified: "Internal credential revocation is not verified; recovery intent must be retained.",
    }[code]);
    this.name = "ContainerCredentialError";
  }
}

export interface ContainerCredentialJournal {
  begin(name: string, expiresOn: string): Promise<void>;
  acknowledged(id: string): Promise<void>;
  revoked(id: string): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One account-only policy. No resource-shaped Containers permission is invented. */
export function containerTokenRequest(env: ContainerIdentity, groupId: string, egressCidrs: string[], nowMs: number, purpose: "deploy" | "cleanup"): TokenRequest {
  assertContainerIdentity(env);
  if (purpose !== "deploy" && purpose !== "cleanup") throw new ContainerCredentialError("invalid_config");
  if (purpose === "deploy") assertContainerActive(env, nowMs);
  if (!idPattern.test(groupId) || !Number.isFinite(nowMs) || nowMs < Date.parse(env.createdAt)
    || !Array.isArray(egressCidrs) || !egressCidrs.length || egressCidrs.some((cidr) => normalizeCidr(cidr) === null)) {
    throw new ContainerCredentialError("invalid_config");
  }
  // Cleanup is allowed after env expiry: expired credentials do not stop billing.
  const ttlSeconds = purpose === "cleanup" ? TOKEN_TTL_SECONDS
    : Math.min(TOKEN_TTL_SECONDS, Math.floor((Date.parse(env.expiresAt) - nowMs) / 1000));
  return buildTokenRequest({
    name: `${env.envId}-containers-g${env.generation}`,
    policies: [{ effect: "allow", resources: { [`${ACCOUNT_RESOURCE}.${env.accountId}`]: "*" }, permission_groups: [{ id: groupId }] }],
    nowMs, ttlSeconds, egressCidrs,
  });
}

export function assertInternalContainerToken(actual: unknown, id: string, expected: TokenRequest, nowMs: number): asserts actual is Record<string, unknown> & { expires_on: string } {
  const fail = (): never => { throw new ContainerCredentialError("verification_failed"); };
  if (!Number.isFinite(nowMs) || !record(actual) || actual.id !== id || actual.status !== "active" || actual.name !== expected.name
    || typeof actual.expires_on !== "string" || typeof actual.not_before !== "string"
    || !Number.isFinite(Date.parse(actual.expires_on)) || !Number.isFinite(Date.parse(actual.not_before))
    || Date.parse(actual.expires_on) > Date.parse(expected.expires_on) || Date.parse(actual.expires_on) <= nowMs
    || Date.parse(actual.not_before) < Date.parse(expected.not_before) || Date.parse(actual.not_before) > nowMs) fail();
  const token = actual as Record<string, unknown>;
  const policies = token.policies;
  if (!Array.isArray(policies) || policies.length !== 1) fail();
  const policy = (policies as unknown[])[0];
  const wanted = expected.policies[0]!;
  if (!record(policy) || policy.effect !== "allow" || !record(policy.resources)
    || Object.keys(policy.resources).length !== 1 || policy.resources[Object.keys(wanted.resources)[0]!] !== "*"
    || !Array.isArray(policy.permission_groups) || policy.permission_groups.length !== 1
    || !record(policy.permission_groups[0]) || policy.permission_groups[0].id !== wanted.permission_groups[0]!.id) fail();
  const condition = token.condition;
  if (!record(condition) || Object.keys(condition).length !== 1 || !record(condition["request.ip"])
    || Object.keys(condition["request.ip"]).length !== 1 || !Array.isArray(condition["request.ip"].in)) fail();
  const granted = ((condition as Record<string, Record<string, unknown>>)["request.ip"]!.in as unknown[]).map(normalizeCidr);
  const wantedCidrs = expected.condition["request.ip"].in.map(normalizeCidr).sort();
  if (granted.some((cidr) => cidr === null) || granted.length !== wantedCidrs.length
    || granted.sort().some((cidr, i) => cidr !== wantedCidrs[i])) fail();
}

/** The only callback capability is the env-scoped application client, never a token value. */
export class ContainerCredentialBroker {
  #fetch: FetchImpl;
  #bootstrap: string;
  #accountId: string;
  #session: ContainerApiSession;
  #now: () => number;

  constructor(fetchImpl: FetchImpl, bootstrap: string, accountId: string, session: ContainerApiSession, now: () => number = Date.now) {
    if (!idPattern.test(accountId) || typeof bootstrap !== "string" || !bootstrap || /[\r\n]/.test(bootstrap)) {
      throw new ContainerCredentialError("invalid_config");
    }
    this.#fetch = fetchImpl;
    this.#bootstrap = bootstrap;
    this.#accountId = accountId;
    this.#session = session;
    this.#now = now;
  }

  private async request(method: "GET" | "POST" | "DELETE", suffix: string, body?: unknown, allowAbsent = false): Promise<unknown> {
    return this.#session.request(() => this.requestOnce(method, suffix, body, allowAbsent));
  }

  private async requestOnce(method: "GET" | "POST" | "DELETE", suffix: string, body?: unknown, allowAbsent = false): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`https://api.cloudflare.com/client/v4/accounts/${this.#accountId}/tokens${suffix}`, {
        method, headers: { Authorization: `Bearer ${this.#bootstrap}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "error",
      });
    } catch { this.#session.stopAfterTransportFailure(); }
    if (response.status === 401) this.#session.stopAfterAuthenticationFailure();
    if (response.status === 404 && allowAbsent) return null;
    if (!response.ok) throw new ContainerApiError("cloudflare_failed", response.status);
    let parsed: unknown;
    try {
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error();
      parsed = JSON.parse(text);
    } catch { throw new ContainerApiError("invalid_response"); }
    if (!record(parsed) || parsed.success !== true || !Object.hasOwn(parsed, "result")) throw new ContainerApiError("invalid_response");
    return parsed.result;
  }

  private async journal(write: () => Promise<void>): Promise<void> {
    try { await write(); } catch { throw new ContainerCredentialError("journal_failed"); }
  }

  async revokeAndVerify(id: string, journal: Pick<ContainerCredentialJournal, "revoked">): Promise<void> {
    if (!idPattern.test(id)) throw new ContainerCredentialError("invalid_config");
    await this.request("DELETE", `/${id}`, undefined, true);
    if (await this.request("GET", `/${id}`, undefined, true) !== null) throw new ContainerCredentialError("revocation_unverified");
    await this.journal(() => journal.revoked(id));
  }

  async withApplicationApi<T>(opts: {
    env: ContainerIdentity; groupId: string; egressCidrs: string[]; purpose: "deploy" | "cleanup";
    journal: ContainerCredentialJournal;
  }, run: (api: ContainerApplicationApi) => Promise<T>): Promise<T> {
    const env = { ...opts.env };
    const { groupId, purpose } = opts;
    if (!Array.isArray(opts.egressCidrs) || !opts.journal
      || [opts.journal.begin, opts.journal.acknowledged, opts.journal.revoked].some((write) => typeof write !== "function")) {
      throw new ContainerCredentialError("invalid_config");
    }
    const expected = containerTokenRequest(env, groupId, [...opts.egressCidrs], this.#now(), purpose);
    if (env.accountId !== this.#accountId) throw new ContainerCredentialError("invalid_config");
    const journal: ContainerCredentialJournal = {
      begin: opts.journal.begin.bind(opts.journal),
      acknowledged: opts.journal.acknowledged.bind(opts.journal),
      revoked: opts.journal.revoked.bind(opts.journal),
    };
    const groups = await this.request("GET", "/permission_groups");
    const matches = Array.isArray(groups) ? groups.filter((group) => record(group) && group.id === groupId) : [];
    const group = matches[0];
    if (matches.length !== 1 || !record(group) || group.name !== CONTAINERS_GROUP_NAME || group.is_selectable !== true
      || !Array.isArray(group.scopes) || group.scopes.length !== 1 || group.scopes[0] !== ACCOUNT_RESOURCE) {
      throw new ContainerCredentialError("permission_unavailable");
    }
    await this.journal(() => journal.begin(expected.name, expected.expires_on));
    let id: string | undefined;
    let open = true;
    try {
      if (purpose === "deploy") assertContainerActive(env, this.#now());
      if (!Number.isFinite(this.#now()) || this.#now() >= Date.parse(expected.expires_on)) {
        throw new ContainerCredentialError("verification_failed");
      }
      const minted = await this.request("POST", "", expected);
      if (!record(minted) || typeof minted.id !== "string" || !idPattern.test(minted.id)) {
        throw new ContainerCredentialError("verification_failed");
      }
      id = minted.id;
      await this.journal(() => journal.acknowledged(id!));
      if (typeof minted.value !== "string" || !minted.value || minted.value.length > 4096 || /[\r\n]/.test(minted.value)) {
        throw new ContainerCredentialError("verification_failed");
      }
      const stored = await this.request("GET", `/${id}`);
      assertInternalContainerToken(stored, id, expected, this.#now());
      if (purpose === "deploy") assertContainerActive(env, this.#now());
      const expiresMs = Date.parse(stored.expires_on);
      const assertCurrent = () => {
        const time = this.#now();
        if (!open || !Number.isFinite(time) || time < Date.parse(expected.not_before) || time >= expiresMs) {
          throw new ContainerApiError("capability_expired");
        }
        if (purpose === "deploy") assertContainerActive(env, time);
      };
      const result = await run(new ContainerApplicationApi(this.#fetch, minted.value, this.#accountId, this.#session, assertCurrent));
      this.#session.assertCallable();
      return result;
    } catch (err) {
      if (err instanceof ContainerApiError || err instanceof ContainerCredentialError || err instanceof ContainerRefusal) throw err;
      throw new ContainerCredentialError("operation_failed");
    } finally {
      open = false;
      // A 401 forbids even cleanup calls in this attempt; the durable ID remains.
      // Outstanding detached work or quarantined transport also prevents a
      // revocation call/receipt; the non-secret recovery obligation remains.
      if (id && !this.#session.authenticationFailed) await this.revokeAndVerify(id, journal);
    }
  }
}
