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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/workers/scripts/${name}`);
  }

  // -- API tokens ---------------------------------------------------------

  async getPermissionGroups(): Promise<PermissionGroup[]> {
    return this.request<PermissionGroup[]>("GET", "/user/tokens/permission_groups");
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
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/tokens/${tokenId}`);
  }

  // -- D1 -----------------------------------------------------------------

  async createD1(name: string): Promise<{ uuid: string }> {
    return this.request<{ uuid: string }>("POST", `/accounts/${this.accountId}/d1/database`, { name });
  }

  async deleteD1(databaseId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/d1/database/${databaseId}`);
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
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/storage/kv/namespaces/${namespaceId}`);
  }

  // -- R2 -----------------------------------------------------------------

  async createBucket(name: string): Promise<void> {
    await this.request<unknown>("PUT", `/accounts/${this.accountId}/r2/buckets/${name}`);
  }

  async listBucketObjects(bucket: string): Promise<Array<{ key: string }>> {
    const result = await this.request<{ objects?: Array<{ key: string }> }>(
      "GET",
      `/accounts/${this.accountId}/r2/buckets/${bucket}/objects?limit=1000`,
    );
    return result.objects ?? [];
  }

  async deleteBucketObjects(bucket: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/r2/buckets/${bucket}/objects`, { keys });
  }

  async deleteBucket(name: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${this.accountId}/r2/buckets/${name}`);
  }
}
