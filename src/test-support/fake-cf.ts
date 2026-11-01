/**
 * In-memory fixture for the Cloudflare v4 API. No real HTTP ever happens in
 * CI: tests point CfClient (or the plugin worker) at this fake and assert on
 * recorded calls — in particular that minted token policies reference ONLY
 * the provisioned Worker/bucket, never production names.
 *
 * The fake is strict like the real API: reading or deleting a missing
 * resource returns 404 (teardown must tolerate that), and R2 listing is
 * cursor-paginated (teardown must follow cursors).
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
  /** Entries of the form "METHOD path-substring": matching calls fail with 500. */
  failOn: string[] = [];
  private seq = 0;

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/client/v4", "");
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
    const apiError = (status: number, message: string) =>
      new Response(JSON.stringify({ success: false, errors: [{ message }], result: null }), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (this.failOn.some((rule) => `${method} ${path}`.includes(rule))) {
      return apiError(500, `injected failure for ${method} ${path}`);
    }

    // Workers scripts
    let m = path.match(/^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)$/);
    if (m && method === "PUT") {
      const name = decodeURIComponent(m[1]!);
      const id = `wid-${name}`;
      this.scripts.set(name, { id });
      return ok({ id, name });
    }
    if (m && method === "GET") {
      const name = decodeURIComponent(m[1]!);
      const script = this.scripts.get(name);
      if (!script) return apiError(404, "script not found");
      return ok({ id: script.id, name });
    }
    if (m && method === "DELETE") {
      const name = decodeURIComponent(m[1]!);
      if (!this.scripts.has(name)) return apiError(404, "script not found");
      this.deletedScripts.push(name);
      this.scripts.delete(name);
      return ok({});
    }
    // Permission groups (account-owned minting credential: account path)
    if (/^\/accounts\/[^/]+\/tokens\/permission_groups$/.test(path) && method === "GET") {
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
      const id = decodeURIComponent(m[1]!);
      this.revokedTokens.push(id);
      this.tokens.delete(id);
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
        return apiError(404, "unknown database");
      }
      this.d1Queries.push({ databaseId, sql: (body as { sql?: string })?.sql ?? "" });
      return ok([{ results: [] }]);
    }
    m = path.match(/^\/accounts\/[^/]+\/d1\/database\/([^/]+)$/);
    if (m && method === "DELETE") {
      const id = decodeURIComponent(m[1]!);
      if (!this.dbs.has(id)) return apiError(404, "unknown database");
      this.dbs.delete(id);
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
      const id = decodeURIComponent(m[1]!);
      if (!this.namespaces.has(id)) return apiError(404, "unknown namespace");
      this.namespaces.delete(id);
      return ok({});
    }
    // R2: cursor-paginated listing, per-object delete.
    m = path.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)\/objects\/([^/]+)$/);
    if (m && method === "DELETE") {
      const bucket = this.buckets.get(decodeURIComponent(m[1]!));
      if (!bucket) return apiError(404, "bucket not found");
      const key = decodeURIComponent(m[2]!);
      bucket.objects = bucket.objects.filter((k) => k !== key);
      return ok({});
    }
    m = path.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)\/objects$/);
    if (m && method === "GET") {
      const keys = this.buckets.get(decodeURIComponent(m[1]!))?.objects ?? [];
      const limit = Math.max(1, Number(parsed.searchParams.get("limit") ?? "1000"));
      const start = Number(parsed.searchParams.get("cursor") ?? "0");
      const page = keys.slice(start, start + limit);
      const next = start + limit;
      return ok({
        objects: page.map((key) => ({ key })),
        truncated: next < keys.length,
        ...(next < keys.length ? { cursor: String(next) } : {}),
      });
    }
    if (/^\/accounts\/[^/]+\/r2\/buckets$/.test(path) && method === "GET") {
      return ok({ buckets: [...this.buckets.keys()].map((name) => ({ name })) });
    }
    m = path.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)$/);
    if (m && method === "PUT") {
      this.buckets.set(decodeURIComponent(m[1]!), { objects: [] });
      return ok({});
    }
    if (m && method === "DELETE") {
      const name = decodeURIComponent(m[1]!);
      if (!this.buckets.has(name)) return apiError(404, "bucket not found");
      this.buckets.delete(name);
      return ok({});
    }
    return apiError(400, `unhandled ${method} ${path}`);
  };

  tokenBodies(): unknown[] {
    return [...this.tokens.values()].map((t) => t.body);
  }
}
