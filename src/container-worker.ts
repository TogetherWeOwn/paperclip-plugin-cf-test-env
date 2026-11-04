import type { FetchImpl } from "./cloudflare.js";
import { ContainerApiError, ContainerApiSession } from "./container-api.js";
import { assertContainerIdentity, assertContainerWorkerOwnership, ContainerRefusal, type ContainerIdentity } from "./container-contract.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read-only evidence capability. Never uploads, deletes, returns metadata or adopts IDs. */
export class ContainerWorkerApi {
  #fetch: FetchImpl;
  #token: string;
  #accountId: string;
  #session: ContainerApiSession;
  #assertCurrent: () => void;

  constructor(fetch: FetchImpl, token: string, accountId: string, session: ContainerApiSession, assertCurrent: () => void = () => undefined) {
    if (!/^[a-f0-9]{32}$/.test(accountId) || typeof token !== "string" || !token || /[\r\n]/.test(token)) {
      throw new ContainerApiError("invalid_response");
    }
    this.#fetch = fetch;
    this.#token = token;
    this.#accountId = accountId;
    this.#session = session;
    this.#assertCurrent = assertCurrent;
  }

  private async request(suffix: string): Promise<{ result: unknown; info?: Record<string, unknown> }> {
    return this.#session.request(async () => {
      this.#assertCurrent();
      const response = await this.#session.dispatch(this.#fetch, `https://api.cloudflare.com/client/v4/accounts/${this.#accountId}/workers/${suffix}`, {
        method: "GET", headers: { Authorization: `Bearer ${this.#token}` }, redirect: "error",
      }, this.#assertCurrent);
      if (response.status === 401) this.#session.stopAfterAuthenticationFailure();
      if (!response.ok) throw new ContainerApiError("cloudflare_failed", response.status);
      let parsed: unknown;
      try {
        const text = await response.text();
        // List Workers is account-wide and has no documented pagination. Give
        // that collection its own budget; other evidence stays limited to 1 MiB.
        const maxBytes = suffix === "scripts" ? 16 * 1024 * 1024 : 1024 * 1024;
        if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error();
        parsed = JSON.parse(text);
      } catch { throw new ContainerApiError("invalid_response"); }
      if (!record(parsed) || parsed.success !== true || !Object.hasOwn(parsed, "result")
        || (parsed.result_info !== undefined && !record(parsed.result_info))) throw new ContainerApiError("invalid_response");
      return { result: parsed.result, info: parsed.result_info as Record<string, unknown> | undefined };
    });
  }

  private async namespace(env: ContainerIdentity): Promise<unknown> {
    const ids = new Set<string>();
    let selected: unknown;
    let totalPages: unknown;
    let totalCount: unknown;
    let count = 0;
    for (let page = 1; page <= 100; page++) {
      const { result, info } = await this.request(`durable_objects/namespaces?page=${page}&per_page=1000`);
      if (!Array.isArray(result) || result.length > 1000 || !info || info.page !== page || info.per_page !== 1000 || info.count !== result.length
        || (info.cursor !== undefined && info.cursor !== "") || (info.next_page_token !== undefined && info.next_page_token !== "")) {
        throw new ContainerApiError("invalid_response");
      }
      if (page === 1) { totalPages = info.total_pages; totalCount = info.total_count; }
      if (info.total_pages !== totalPages || info.total_count !== totalCount
        || (totalPages !== undefined && (!Number.isSafeInteger(totalPages) || (totalPages as number) < 0 || (totalPages as number) > 100))
        || (totalCount !== undefined && (!Number.isSafeInteger(totalCount) || (totalCount as number) < 0))) throw new ContainerApiError("invalid_response");
      for (const item of result) {
        if (!record(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
          || typeof item.script !== "string" || typeof item.class !== "string" || ids.has(item.id)) throw new ContainerApiError("invalid_response");
        ids.add(item.id);
        if (item.id === env.namespaceId || item.script === env.workerName) {
          if (selected !== undefined || item.id !== env.namespaceId || item.script !== env.workerName) throw new ContainerRefusal("ownership_mismatch");
          selected = item;
        }
      }
      count += result.length;
      if (typeof totalCount === "number" && count > totalCount) throw new ContainerApiError("invalid_response");
      const last = typeof totalPages === "number" ? page >= totalPages
        : typeof totalCount === "number" ? count === totalCount : result.length < 1000;
      if (last) {
        if ((typeof totalCount === "number" && count !== totalCount) || (totalPages === 0 && count !== 0)) throw new ContainerApiError("invalid_response");
        return selected;
      }
      if (result.length === 0) throw new ContainerApiError("invalid_response");
    }
    throw new ContainerApiError("invalid_response");
  }

  /** Point-in-time evidence only; the lifecycle still owns writer exclusion and source attestation. */
  async verifyOwned(identity: ContainerIdentity, pinnedVersionId: string): Promise<void> {
    const env = { ...identity };
    const versionId = pinnedVersionId;
    assertContainerIdentity(env);
    if (env.accountId !== this.#accountId || typeof versionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(versionId)) {
      throw new ContainerRefusal("ownership_mismatch");
    }
    const scripts = await this.request("scripts");
    // The pinned List Workers endpoint has no pagination parameters. Never treat
    // a truncated/cursor response as its documented complete collection.
    if (!Array.isArray(scripts.result) || (scripts.info && (scripts.info.cursor || scripts.info.next_page_token
      || (scripts.info.total_pages !== undefined && scripts.info.total_pages !== 1)
      || (scripts.info.total_count !== undefined && scripts.info.total_count !== scripts.result.length)))) throw new ContainerApiError("invalid_response");
    const matches = scripts.result.filter((script) => {
      if (!record(script) || typeof script.id !== "string") throw new ContainerApiError("invalid_response");
      return script.id === env.workerName || script.tag === env.workerTag;
    });
    const script: unknown = matches[0];
    if (matches.length !== 1 || !record(script) || script.id !== env.workerName || script.tag !== env.workerTag) throw new ContainerRefusal("ownership_mismatch");
    const version = await this.request(`scripts/${env.workerName}/versions/${versionId}`);
    const namespace = await this.namespace(env);
    // Read the serving deployment last, not just any matching historical entry.
    const deployments = await this.request(`scripts/${env.workerName}/deployments`);
    assertContainerWorkerOwnership(script, version.result, deployments.result, namespace, env, versionId);
    this.#session.assertCallable();
    this.#assertCurrent();
  }
}
