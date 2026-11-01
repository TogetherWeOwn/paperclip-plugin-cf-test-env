/**
 * In-memory fixture for the Cloudflare v4 API. No real HTTP ever happens in
 * CI: tests point CfClient (or the plugin worker) at this fake and assert on
 * recorded calls — in particular that minted token policies reference ONLY
 * the provisioned Worker/bucket, never production names.
 */
export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export class FakeCf {
  readonly calls: RecordedCall[] = [];
  scripts = new Map<string, { id: string }>();
  dbs = new Map<string, { name: string }>();
  namespaces = new Map<string, { title: string }>();
  buckets = new Map<string, { objects: string[] }>();
  tokens = new Map<string, { body: unknown; value: string }>();
  d1Queries: Array<{ databaseId: string; sql: string }> = [];
  deletedScripts: string[] = [];
  revokedTokens: string[] = [];
  groups = [
    { id: "grp-worker-admin", name: "Individual Workers Admin" },
    { id: "grp-r2-item-write", name: "Workers R2 Storage Bucket Item Write" },
  ];
  private seq = 0;

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("https://api.cloudflare.com/client/v4", "").split("?")[0]!;
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = String(init?.body);
    }
    this.calls.push({ method, path, body });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    // Workers scripts
    let m = path.match(/^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)$/);
    if (m && method === "PUT") {
      const name = decodeURIComponent(m[1]!);
      const id = `wid-${name}`;
      this.scripts.set(name, { id });
      return ok({ id, name });
    }
    if (m && method === "DELETE") {
      const name = decodeURIComponent(m[1]!);
      this.deletedScripts.push(name);
      this.scripts.delete(name);
      return ok({});
    }
    // Permission groups
    if (path === "/user/tokens/permission_groups" && method === "GET") {
      return ok(this.groups);
    }
    // Account tokens
    if (/^\/accounts\/[^/]+\/tokens$/.test(path) && method === "POST") {
      this.seq += 1;
      const id = `tok-${this.seq}`;
      const value = `secret-value-${this.seq}`;
      this.tokens.set(id, { body, value });
      return ok({ id, value });
    }
    m = path.match(/^\/accounts\/[^/]+\/tokens\/([^/]+)$/);
    if (m && method === "DELETE") {
      this.revokedTokens.push(decodeURIComponent(m[1]!));
      return ok({});
    }
    // D1
    if (/^\/accounts\/[^/]+\/d1\/database$/.test(path) && method === "POST") {
      this.seq += 1;
      const uuid = `d1-${this.seq}`;
      this.dbs.set(uuid, { name: (body as { name?: string })?.name ?? uuid });
      return ok({ uuid });
    }
    m = path.match(/^\/accounts\/[^/]+\/d1\/database\/([^/]+)\/query$/);
    if (m && method === "POST") {
      const databaseId = decodeURIComponent(m[1]!);
      if (!this.dbs.has(databaseId)) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: "unknown database" }], result: null }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      this.d1Queries.push({ databaseId, sql: (body as { sql?: string })?.sql ?? "" });
      return ok([{ results: [] }]);
    }
    m = path.match(/^\/accounts\/[^/]+\/d1\/database\/([^/]+)$/);
    if (m && method === "DELETE") {
      this.dbs.delete(decodeURIComponent(m[1]!));
      return ok({});
    }
    // KV
    if (/^\/accounts\/[^/]+\/storage\/kv\/namespaces$/.test(path) && method === "POST") {
      this.seq += 1;
      const id = `kv-${this.seq}`;
      this.namespaces.set(id, { title: (body as { title?: string })?.title ?? id });
      return ok({ id });
    }
    m = path.match(/^\/accounts\/[^/]+\/storage\/kv\/namespaces\/([^/]+)$/);
    if (m && method === "DELETE") {
      this.namespaces.delete(decodeURIComponent(m[1]!));
      return ok({});
    }
    // R2
    m = path.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)\/objects$/);
    if (m && method === "GET") {
      const bucket = this.buckets.get(decodeURIComponent(m[1]!));
      return ok({ objects: (bucket?.objects ?? []).map((key) => ({ key })) });
    }
    if (m && method === "DELETE") {
      const bucket = this.buckets.get(decodeURIComponent(m[1]!));
      if (bucket) bucket.objects = [];
      return ok({});
    }
    m = path.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)$/);
    if (m && method === "PUT") {
      this.buckets.set(decodeURIComponent(m[1]!), { objects: [] });
      return ok({});
    }
    if (m && method === "DELETE") {
      this.buckets.delete(decodeURIComponent(m[1]!));
      return ok({});
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unhandled ${method} ${path}` }], result: null }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  tokenBodies(): unknown[] {
    return [...this.tokens.values()].map((t) => t.body);
  }
}
