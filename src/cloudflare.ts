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

const CF_API = "https://api.cloudflare.com/client/v4";

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
    let parsed: { success?: boolean; errors?: Array<{ message?: string }>; result?: T } = {};
    try {
      parsed = text ? (JSON.parse(text) as typeof parsed) : {};
    } catch {
      throw new CfError(res.status, text.slice(0, 500), `Cloudflare ${method} ${path}: non-JSON response ${res.status}`);
    }
    if (!res.ok || parsed.success === false) {
      // Teardown must be idempotent: a token that already expired (or was
      // already revoked) and an already-deleted resource both return 404 on
      // retry. Treat 404 on DELETE as success so envs can't get stuck in
      // state forever and count against the concurrency cap.
      if (opts?.tolerateNotFound && res.status === 404) {
        return undefined as T;
      }
      const detail = (parsed.errors ?? []).map((e) => e.message ?? "").filter(Boolean).join("; ");
      throw new CfError(res.status, text.slice(0, 500), `Cloudflare ${method} ${path} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
    }
    return parsed.result as T;
  }

  // -- Workers ----------------------------------------------------------

  /** Upload a stub script. Returns the Worker id used for per-Worker scoping. */
  async createWorkerScript(name: string): Promise<{ id: string }> {
    const stub = `export default { async fetch() { return new Response("pct stub", { status: 200 }); } };`;
    return this.request<{ id: string }>("PUT", `/accounts/${this.accountId}/workers/scripts/${name}`, {
      script: stub,
      bindings: [],
    });
  }

  async deleteWorkerScript(name: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/workers/scripts/${name}`, undefined, {
      tolerateNotFound: true,
    });
  }

  /**
   * Fetch script metadata. Returns null when the script doesn't exist (404),
   * so provision can fail closed instead of silently overwriting a
   * pre-existing Worker with a PUT.
   */
  async getWorkerScript(name: string): Promise<{ id: string } | null> {
    try {
      return await this.request<{ id: string }>(
        "GET",
        `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(name)}`,
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

  async createBucket(name: string): Promise<void> {
    await this.request<unknown>("PUT", `/accounts/${this.accountId}/r2/buckets/${name}`);
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
   */
  async deleteBucketObject(bucket: string, key: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/accounts/${this.accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
      undefined,
      { tolerateNotFound: true },
    );
  }

  /**
   * Names of all R2 buckets in the account. Used as an existence check before
   * creating an env bucket, so provision never adopts (and later empties and
   * deletes) a foreign bucket that happens to share the generated name.
   */
  async listBuckets(): Promise<string[]> {
    const result = await this.request<{ buckets?: Array<{ name: string }> }>(
      "GET",
      `/accounts/${this.accountId}/r2/buckets`,
    );
    return (result.buckets ?? []).map((b) => b.name).filter((n) => typeof n === "string");
  }

  async deleteBucket(name: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/r2/buckets/${name}`, undefined, {
      tolerateNotFound: true,
    });
  }
}
