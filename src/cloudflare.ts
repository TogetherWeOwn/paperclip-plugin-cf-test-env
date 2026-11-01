/**
 * Minimal Cloudflare API client. All HTTP goes through the injected fetch
 * (ctx.http.fetch in the worker, a fixture in tests) so CI never touches
 * the real API.
 *
 * Endpoint shapes follow api.cloudflare.com v4. Token-minting and resource
 * management need the plugin's minting credential; the short-lived env
 * tokens minted by this plugin can only ever touch their own Worker/bucket.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class CfError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "CfError";
    this.status = status;
    this.body = body;
  }
}

/**
 * True for Cloudflare authentication failures (bad/expired credential, or a
 * request.ip filter that doesn't cover the caller — the canary showed filter
 * violations surface as 401). Cloudflare locks the caller out after repeated
 * authentication failures, so no caller may retry or loop over calls that
 * fail this way: `emptyBucket`, `rollbackPartial`, `teardown` and `sweep`
 * all abort their remaining Cloudflare calls on the first 401 and surface it
 * instead.
 *
 * A 403 is deliberately NOT covered: it means the credential authenticated
 * but is forbidden for that operation, which is resource-specific (and does
 * not feed the lockout counter). 403s are recorded as ordinary step errors
 * so one forbidden resource neither aborts its env's remaining cleanup nor
 * starves the rest of the sweep.
 */
export function isAuthenticationFailure(err: unknown): boolean {
  return err instanceof CfError && err.status === 401;
}

const CF_API = "https://api.cloudflare.com/client/v4";

/**
 * Detail string from a v4 error envelope. Defensive about shape: a proxy or
 * truncated body can yield `null`, a non-object, or null entries, and the
 * status must survive that — the stop-on-401 guarantee rides on every
 * failure surfacing as `CfError` with the real status, never a TypeError.
 */
function errorDetail(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null) return "";
  const errors = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return "";
  return errors
    .map((e) => (typeof e === "object" && e !== null ? (e as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === "string" && m.length > 0)
    .join("; ");
}

/** Coerce a parsed JSON body to an envelope object; `null` and non-objects become `{}`. */
function asEnvelope<T>(value: unknown): { success?: boolean; errors?: Array<{ message?: string }>; result?: T; result_info?: { cursor?: string } } {
  return typeof value === "object" && value !== null
    ? (value as { success?: boolean; errors?: Array<{ message?: string }>; result?: T; result_info?: { cursor?: string } })
    : {};
}

export interface PermissionGroup {
  id: string;
  name: string;
}

export class CfClient {
  constructor(
    private readonly fetchImpl: FetchImpl,
    private readonly apiToken: string,
    readonly accountId: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, opts?: { tolerateNotFound?: boolean }): Promise<T> {
    const { status, text, parsed } = await this.fetchEnvelope<T>(method, path, body, opts);
    // A tolerated 404 (JSON or otherwise) means "already absent": success.
    if (status === 404 && opts?.tolerateNotFound) {
      return undefined as T;
    }
    this.throwOnError(method, path, status, text, parsed);
    return parsed.result as T;
  }

  /**
   * Raw envelope fetch shared by `request` and the paginated listers. The v4
   * envelope carries pagination in `result_info` (sibling of `result`, not
   * inside it), so callers that page need the whole envelope.
   */
  private async fetchEnvelope<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { tolerateNotFound?: boolean },
  ): Promise<{
    status: number;
    text: string;
    parsed: { success?: boolean; errors?: Array<{ message?: string }>; result?: T; result_info?: { cursor?: string } };
  }> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const res = await this.fetchImpl(`${CF_API}${path}`, init);
    const text = await res.text();
    let parsed: {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: T;
      result_info?: { cursor?: string };
    } = {};
    try {
      parsed = text ? asEnvelope<T>(JSON.parse(text)) : {};
    } catch {
      // A 404 with an HTML body still means "absent" on tolerant deletes;
      // without this, teardown keeps the state record and retries forever.
      if (opts?.tolerateNotFound && res.status === 404) {
        return { status: res.status, text, parsed: {} };
      }
      throw new CfError(res.status, text.slice(0, 500), `Cloudflare ${method} ${path}: non-JSON response ${res.status}`);
    }
    return { status: res.status, text, parsed };
  }

  /** Throw unless the envelope is a successful 2xx response. */
  private throwOnError(
    method: string,
    path: string,
    status: number,
    text: string,
    parsed: { success?: boolean; errors?: Array<{ message?: string }> },
  ): void {
    // Teardown must be idempotent: a token that already expired (or was
    // already revoked) and an already-deleted resource both return 404 on
    // retry. Callers that tolerate it return early above, so reaching here
    // with a 404 or a non-2xx is a real failure.
    if (status >= 200 && status < 300 && parsed.success !== false) return;
    const detail = errorDetail(parsed);
    throw new CfError(status, text.slice(0, 500), `Cloudflare ${method} ${path} failed: ${status}${detail ? ` ${detail}` : ""}`);
  }

  // -- Workers ----------------------------------------------------------

  /**
   * Upload a stub script. The script-upload endpoint takes multipart/form-data
   * (a `metadata` part plus the module), not JSON — a JSON body is rejected.
   * Returns the Worker id the per-Worker role is keyed on. (The classic script
   * API returns the script name as `id` plus a separate `tag`; provision uses
   * the returned `id` for scoping and the canary confirms it against the real
   * API.)
   */
  async createWorkerScript(name: string): Promise<{ id: string }> {
    const stub = `export default { async fetch() { return new Response("pct stub", { status: 200 }); } };`;
    const form = new FormData();
    form.set(
      "metadata",
      new Blob([JSON.stringify({ main_module: "worker.js", bindings: [] })], {
        type: "application/json",
      }),
    );
    form.set("worker.js", new Blob([stub], { type: "application/javascript+module" }), "worker.js");
    const res = await this.fetchImpl(`${CF_API}/accounts/${this.accountId}/workers/scripts/${name}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: form,
    });
    const text = await res.text();
    let parsed: { success?: boolean; errors?: Array<{ message?: string }>; result?: { id: string } } = {};
    try {
      parsed = text ? asEnvelope<{ id: string }>(JSON.parse(text)) : {};
    } catch {
      throw new CfError(res.status, text.slice(0, 500), `Cloudflare PUT workers/scripts/${name}: non-JSON response ${res.status}`);
    }
    if (!res.ok || parsed.success === false) {
      const detail = errorDetail(parsed);
      throw new CfError(
        res.status,
        text.slice(0, 500),
        `Cloudflare PUT workers/scripts/${name} failed: ${res.status}${detail ? ` ${detail}` : ""}`,
      );
    }
    return parsed.result as { id: string };
  }

  async deleteWorkerScript(name: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/workers/scripts/${name}`, undefined, {
      tolerateNotFound: true,
    });
  }

  /**
   * Check whether a script exists. Uses the settings sub-resource (JSON) rather
   * than fetching the script itself: on a script that exists the content
   * endpoint returns the script body, which is not JSON and would throw.
   * Returns null when the script doesn't exist (404), so provision can fail
   * closed instead of silently overwriting a pre-existing Worker with a PUT.
   */
  async getWorkerScript(name: string): Promise<{ id: string } | null> {
    try {
      return await this.request<{ id: string }>(
        "GET",
        `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(name)}/settings`,
      );
    } catch (err) {
      if (err instanceof CfError && err.status === 404) return null;
      throw err;
    }
  }

  // -- API tokens ---------------------------------------------------------

  async getPermissionGroups(): Promise<PermissionGroup[]> {
    // The minting credential is account-owned, so permission groups resolve
    // under the account — not under /user, which belongs to user tokens.
    return this.request<PermissionGroup[]>("GET", `/accounts/${this.accountId}/tokens/permission_groups`);
  }

  async resolvePermissionGroupId(name: string, overrideId: string): Promise<string> {
    if (overrideId) return overrideId;
    const groups = await this.getPermissionGroups();
    const found = groups.find((g) => g.name === name);
    if (!found) {
      throw new Error(`Cloudflare permission group ${JSON.stringify(name)} not found; refusing to mint a token`);
    }
    return found.id;
  }

  async createAccountToken(body: unknown): Promise<{ id: string; value: string }> {
    return this.request<{ id: string; value: string }>(
      "POST",
      `/accounts/${this.accountId}/tokens`,
      body,
    );
  }

  /** Read back a minted token so provision can verify it matches the request. */
  async getAccountToken(tokenId: string): Promise<unknown> {
    return this.request<unknown>("GET", `/accounts/${this.accountId}/tokens/${tokenId}`);
  }

  async revokeAccountToken(tokenId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/tokens/${tokenId}`, undefined, {
      tolerateNotFound: true,
    });
  }

  // -- D1 -----------------------------------------------------------------

  async createD1(name: string): Promise<{ uuid: string }> {
    return this.request<{ uuid: string }>("POST", `/accounts/${this.accountId}/d1/database`, { name });
  }

  async deleteD1(databaseId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/d1/database/${databaseId}`, undefined, {
      tolerateNotFound: true,
    });
  }

  async d1Query(databaseId: string, sql: string, params?: unknown[]): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/accounts/${this.accountId}/d1/database/${databaseId}/query`,
      { sql, params: params ?? [] },
    );
  }

  // -- KV -----------------------------------------------------------------

  async createNamespace(title: string): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", `/accounts/${this.accountId}/storage/kv/namespaces`, { title });
  }

  async deleteNamespace(namespaceId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/accounts/${this.accountId}/storage/kv/namespaces/${namespaceId}`,
      undefined,
      { tolerateNotFound: true },
    );
  }

  // -- R2 -----------------------------------------------------------------

  /**
   * Create a bucket. Creation is `POST /r2/buckets` with `{name}` — a POST for
   * an existing bucket conflicts, which backs up the pre-create existence
   * check in provision.
   */
  async createBucket(name: string): Promise<void> {
    await this.request<unknown>("POST", `/accounts/${this.accountId}/r2/buckets`, { name });
  }

  /**
   * One page of bucket objects. The cursor returned here feeds the next
   * call; `truncated` false means the bucket is fully listed.
   */
  async listBucketObjects(
    bucket: string,
    cursor?: string,
  ): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }> {
    const params = new URLSearchParams({ limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const result = await this.request<{
      objects?: Array<{ key: string }>;
      truncated?: boolean;
      cursor?: string;
    }>("GET", `/accounts/${this.accountId}/r2/buckets/${bucket}/objects?${params.toString()}`);
    return { objects: result.objects ?? [], truncated: result.truncated ?? false, cursor: result.cursor };
  }

  /**
   * Delete a single object. Per-object delete is used because the bulk
   * `DELETE .../objects` with a `{keys}` body could not be confirmed in the
   * v4 API; deleting per key is slower but definitely exists.
   *
   * Each `/` stays a literal path separator (the Delete Object reference
   * requires `object_key` slashes unencoded — `%2F` addresses a different,
   * missing object, whose 404-tolerant delete would silently leave the real
   * object behind and wedge the bucket non-empty). Every other reserved
   * character is encoded within its segment; `.`/`..` segments are escaped so
   * URL parsing cannot normalise them away before the request is sent.
   */
  async deleteBucketObject(bucket: string, key: string): Promise<void> {
    const encodedKey = key
      .split("/")
      .map((segment) =>
        segment === "." ? "%2E" : segment === ".." ? "%2E%2E" : encodeURIComponent(segment),
      )
      .join("/");
    await this.request<unknown>(
      "DELETE",
      `/accounts/${this.accountId}/r2/buckets/${bucket}/objects/${encodedKey}`,
      undefined,
      { tolerateNotFound: true },
    );
  }

  /**
   * Names of all R2 buckets in the account. Used as an existence check before
   * creating an env bucket, so provision never adopts (and later empties and
   * deletes) a foreign bucket that happens to share the generated name. The
   * account already holds more buckets than one page, so every page is
   * followed (`per_page=1000` + cursor) — a single page could miss a name and
   * let provision adopt a foreign bucket.
   *
   * Any non-empty cursor means another page, whether or not the response sets
   * `truncated`: the v4 list-buckets response can return a cursor without it.
   * Pagination also lives in the envelope's `result_info.cursor`, not inside
   * `result`, so both locations are read.
   */
  async listBuckets(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ per_page: "1000" });
      if (cursor) params.set("cursor", cursor);
      const { status, text, parsed } = await this.fetchEnvelope<{
        buckets?: Array<{ name: string }>;
        truncated?: boolean;
        cursor?: string;
      }>("GET", `/accounts/${this.accountId}/r2/buckets?${params.toString()}`);
      this.throwOnError("GET", `/accounts/${this.accountId}/r2/buckets`, status, text, parsed);
      const result = parsed.result ?? {};
      for (const b of result.buckets ?? []) {
        if (typeof b.name === "string") names.push(b.name);
      }
      const next = result.cursor || parsed.result_info?.cursor;
      if (!next) break;
      cursor = next;
    }
    return names;
  }

  async deleteBucket(name: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/r2/buckets/${name}`, undefined, {
      tolerateNotFound: true,
    });
  }
}
