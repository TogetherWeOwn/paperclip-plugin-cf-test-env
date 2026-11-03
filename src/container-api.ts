import type { FetchImpl } from "./cloudflare.js";
import {
  assertContainerApplication,
  assertContainerIdentity,
  assertOwnedContainerApplication,
  buildContainerApplication,
  type ContainerIdentity,
} from "./container-contract.js";

export class ContainerApiError extends Error {
  constructor(
    readonly code: "authentication_failed" | "cloudflare_failed" | "invalid_response" | "transport_failed" | "cleanup_unverified" | "journal_failed" | "operation_in_progress" | "capability_expired",
    readonly status?: number,
  ) {
    super({
      authentication_failed: "Container API authentication failed; remaining calls stopped.",
      cloudflare_failed: "Container API operation failed; cleanup state must be retained.",
      invalid_response: "Container API returned an unverified response.",
      transport_failed: "Container API transport failed; remote outcome may be ambiguous.",
      cleanup_unverified: "Container application absence is not verified; cleanup state must be retained.",
      journal_failed: "Container application journal update failed; recovery is required.",
      operation_in_progress: "Container API request is already in progress; no overlapping call is authorized.",
      capability_expired: "Container application capability has closed or expired.",
    }[code]);
    this.name = "ContainerApiError";
  }
}

/** Share across all credentials in one lifecycle attempt, including revocation. */
export class ContainerApiSession {
  #authenticationFailed = false;
  #transportFailed = false;
  #inFlight = false;

  /** No queue: a pending request can still fail authentication or be ambiguous. */
  async request<T>(run: () => Promise<T>): Promise<T> {
    this.assertCallable();
    if (this.#inFlight) throw new ContainerApiError("operation_in_progress");
    this.#inFlight = true;
    try { return await run(); }
    finally { this.#inFlight = false; }
  }

  get authenticationFailed(): boolean {
    return this.#authenticationFailed;
  }

  stopAfterAuthenticationFailure(): never {
    this.#authenticationFailed = true;
    throw new ContainerApiError("authentication_failed", 401);
  }

  stopAfterTransportFailure(): never {
    // RPC timeout rejects locally without cancelling host/provider work. This
    // attempt cannot dispatch again, even if a late host reply eventually arrives.
    this.#transportFailed = true;
    throw new ContainerApiError("transport_failed");
  }

  assertCallable(): void {
    if (this.#authenticationFailed) throw new ContainerApiError("authentication_failed", 401);
    if (this.#transportFailed) throw new ContainerApiError("transport_failed");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Envelope {
  result: unknown;
  result_info?: Record<string, unknown>;
}

/**
 * Account-scoped credential, env-scoped operations. No generic API/proxy method
 * is exposed. The lifecycle handler must authorize and consume consent first.
 * All HTTP uses injected host fetch; OCI/binary transfer is deliberately absent.
 */
export class ContainerApplicationApi {
  #token: string;
  #fetch: FetchImpl;
  #session: ContainerApiSession;
  #accountId: string;
  #assertCurrent: () => void;

  constructor(fetchImpl: FetchImpl, token: string, accountId: string, session: ContainerApiSession, assertCurrent: () => void = () => undefined) {
    if (!/^[a-f0-9]{32}$/.test(accountId) || typeof token !== "string" || !token || /[\r\n]/.test(token)) {
      throw new ContainerApiError("invalid_response");
    }
    this.#fetch = fetchImpl;
    this.#token = token;
    this.#accountId = accountId;
    this.#session = session;
    this.#assertCurrent = assertCurrent;
  }

  private assertAccount(env: ContainerIdentity): ContainerIdentity {
    const captured = { ...env };
    assertContainerIdentity(captured);
    if (captured.accountId !== this.#accountId) throw new ContainerApiError("invalid_response");
    return captured;
  }

  private async request(method: "GET" | "POST" | "DELETE", suffix: string, body?: unknown, allowAbsent = false): Promise<Envelope | null> {
    return this.#session.request(() => {
      this.#assertCurrent();
      return this.requestOnce(method, suffix, body, allowAbsent);
    });
  }

  private async requestOnce(method: "GET" | "POST" | "DELETE", suffix: string, body?: unknown, allowAbsent = false): Promise<Envelope | null> {
    let response: Response;
    try {
      response = await this.#fetch(`https://api.cloudflare.com/client/v4/accounts/${this.#accountId}/containers/applications${suffix}`, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      });
    } catch {
      // Network exceptions can include URLs/headers. Never keep their cause.
      this.#session.stopAfterTransportFailure();
    }
    if (response.status === 401) this.#session.stopAfterAuthenticationFailure();
    if (response.status === 404 && allowAbsent) return null;
    if (!response.ok) throw new ContainerApiError("cloudflare_failed", response.status);
    let parsed: unknown;
    try {
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error();
      parsed = JSON.parse(text);
    } catch {
      throw new ContainerApiError("invalid_response", response.status);
    }
    if (!record(parsed) || parsed.success !== true || !Object.hasOwn(parsed, "result")
      || (parsed.result_info !== undefined && !record(parsed.result_info))) {
      throw new ContainerApiError("invalid_response", response.status);
    }
    return { result: parsed.result, result_info: parsed.result_info as Record<string, unknown> | undefined };
  }

  private async readApplication(env: ContainerIdentity): Promise<(Record<string, unknown> & { id: string }) | null> {
    env = this.assertAccount(env);
    if (!env.applicationId) throw new ContainerApiError("invalid_response");
    const response = await this.request("GET", `/${env.applicationId}`, undefined, true);
    if (response === null) return null;
    assertOwnedContainerApplication(response.result, env);
    return response.result;
  }

  /** Return only the ownership reference, never arbitrary provider metadata. */
  async readOwned(env: ContainerIdentity): Promise<{ id: string } | null> {
    const app = await this.readApplication(env);
    return app === null ? null : { id: app.id };
  }

  /** Persist the acknowledged ID before cap validation, even on an unsafe read-back. */
  async create(env: ContainerIdentity, approvedImage: string, recordApplication: (id: string) => Promise<void>): Promise<string> {
    env = this.assertAccount(env);
    if (env.applicationId) throw new ContainerApiError("invalid_response");
    const body = buildContainerApplication(env, approvedImage);
    const response = await this.request("POST", "", body);
    if (!response) throw new ContainerApiError("invalid_response");
    assertOwnedContainerApplication(response.result, env);
    const id = response.result.id;
    try {
      await recordApplication(id);
    } catch {
      throw new ContainerApiError("journal_failed");
    }
    assertContainerApplication(response.result, { ...env, applicationId: id });
    // The write response is not proof that the remotely stored cap matches.
    const stored = await this.readApplication({ ...env, applicationId: id });
    assertContainerApplication(stored, { ...env, applicationId: id });
    return id;
  }

  /**
   * Full cursor inventory, not a name-prefix scan. A matching name with a foreign
   * namespace (or vice versa) is a conflict, never an adopted cleanup target.
   */
  async findOwned(env: ContainerIdentity): Promise<string[]> {
    env = this.assertAccount(env);
    const ids: string[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const params = new URLSearchParams({ per_page: "500" });
      if (pageToken) params.set("page_token", pageToken);
      const response = await this.request("GET", `?${params.toString()}`);
      if (!response || !Array.isArray(response.result) || !response.result_info) {
        throw new ContainerApiError("invalid_response");
      }
      for (const app of response.result) {
        if (!record(app) || typeof app.name !== "string" || !record(app.durable_objects)) {
          // Non-DO applications are valid inventory entries, but malformed
          // ownership metadata cannot count as evidence of absence.
          if (record(app) && typeof app.name === "string" && app.durable_objects === undefined) {
            if (app.name === env.applicationName) throw new ContainerApiError("cleanup_unverified");
            continue;
          }
          throw new ContainerApiError("invalid_response");
        }
        if (app.name !== env.applicationName && app.durable_objects.namespace_id !== env.namespaceId) continue;
        assertOwnedContainerApplication(app, env);
        if (ids.includes(app.id)) throw new ContainerApiError("invalid_response");
        ids.push(app.id);
      }
      const next = response.result_info.next_page_token;
      if (next === undefined || next === "") return ids;
      if (typeof next !== "string" || next.length > 4096 || seen.has(next)) {
        throw new ContainerApiError("invalid_response");
      }
      seen.add(next);
      pageToken = next;
    }
    throw new ContainerApiError("invalid_response");
  }

  /** Application first; the lifecycle caller must not delete its Worker on failure. */
  async deleteAndVerify(env: ContainerIdentity): Promise<void> {
    env = this.assertAccount(env);
    const existing = await this.readOwned(env);
    if (existing !== null) await this.request("DELETE", `/${env.applicationId}`, undefined, true);
    if (await this.readOwned(env) !== null || (await this.findOwned(env)).length !== 0) {
      throw new ContainerApiError("cleanup_unverified");
    }
  }
}
