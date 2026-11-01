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
  /** Raw query string (without the leading `?`), so tests can assert on
   * pagination parameters. */
  query: string;
  body: unknown;
}

export class FakeCf {
  readonly calls: RecordedCall[] = [];
  scripts = new Map<string, { id: string; tag: string }>();
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
  /**
   * Entries of the form "METHOD path-substring": matching calls fail with
   * 401, simulating a dead minting credential or an IP filter that doesn't
   * cover the caller. Teardown/rollback/sweep must abort, not retry.
   */
  failWithAuthOn: string[] = [];
  /**
   * Entries of the form "METHOD path-substring": matching calls fail with
   * 403, simulating a resource-specific permission problem. Unlike a 401 this
   * must NOT abort the remaining cleanup or starve the rest of the sweep.
   */
  failWithForbiddenOn: string[] = [];
  /**
   * When true, reading a token back returns its stored body with the
   * `condition` stripped — simulating an API that silently drops an
   * unrecognised condition key. Provision must revoke and fail closed.
   */
  dropTokenConditionOnRead = false;
  /**
   * Rewrite the stored token body on read (applied after
   * `dropTokenConditionOnRead`). Simulates the API storing broader grants
   * than requested — e.g. a widened resource value or permission group.
   * Provision must revoke and fail closed.
   */
  mutateTokenOnRead?: (body: Record<string, unknown>) => Record<string, unknown>;
  /**
   * When true, bucket-list pages carry the cursor in the envelope's
   * `result_info` (like the real v4 response) instead of inside `result`, and
   * omit `truncated`. The client must follow either location.
   */
  bucketListCursorViaResultInfo = false;
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
    this.calls.push({ method, path, query: parsed.searchParams.toString(), body });
    const ok = (result: unknown, resultInfo?: unknown) =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result,
          ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    const apiError = (status: number, message: string) =>
      new Response(JSON.stringify({ success: false, errors: [{ message }], result: null }), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (this.failOn.some((rule) => `${method} ${path}`.includes(rule))) {
      return apiError(500, `injected failure for ${method} ${path}`);
    }
    if (this.failWithAuthOn.some((rule) => `${method} ${path}`.includes(rule))) {
      return apiError(401, `injected auth failure for ${method} ${path}`);
    }
    if (this.failWithForbiddenOn.some((rule) => `${method} ${path}`.includes(rule))) {
      return apiError(403, `injected forbidden failure for ${method} ${path}`);
    }

    // Workers scripts
    let m = path.match(/^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)$/);
    if (m && method === "PUT") {
      // Accepts the real multipart upload (body is FormData, not JSON); the
      // fake only tracks existence by name from the path. Like the real API,
      // the response carries `id` = script name plus a separate `tag` =
      // Worker ID, which is what the per-Worker token is scoped to.
      const name = decodeURIComponent(m[1]!);
      const tag = `tag-${name}`;
      this.scripts.set(name, { id: name, tag });
      return ok({ id: name, tag, name });
    }
    const settings = path.match(/^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/settings$/);
    if (settings && method === "GET") {
      // Existence check via the JSON settings sub-resource: fetching the
      // script itself returns the script body, which is not JSON.
      const name = decodeURIComponent(settings[1]!);
      const script = this.scripts.get(name);
      if (!script) return apiError(404, "script not found");
      return ok({ id: script.id, tag: script.tag, name });
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
    if (m && method === "GET") {
      const id = decodeURIComponent(m[1]!);
      const stored = this.tokens.get(id);
      if (!stored) return apiError(404, "token not found");
      const body = stored.body as Record<string, unknown>;
      const stripped = this.dropTokenConditionOnRead
        ? (({ condition: _dropped, ...rest }) => rest)(body)
        : { ...body };
      const result = this.mutateTokenOnRead ? this.mutateTokenOnRead(stripped) : stripped;
      return ok({ id, ...result });
    }
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
    // The key match is greedy across `/`: object keys contain literal
    // separators, one segment per path element.
    m = path.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)\/objects\/(.+)$/);
    if (m && method === "DELETE") {
      const bucket = this.buckets.get(decodeURIComponent(m[1]!));
      if (!bucket) return apiError(404, "bucket not found");
      const key = m[2]!.split("/").map((s) => decodeURIComponent(s)).join("/");
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
      // Cursor-paginated like the real listing: the client must follow pages.
      const names = [...this.buckets.keys()];
      const perPage = Math.max(1, Number(parsed.searchParams.get("per_page") ?? "1000"));
      const start = Number(parsed.searchParams.get("cursor") ?? "0");
      const page = names.slice(start, start + perPage);
      const next = start + perPage;
      if (this.bucketListCursorViaResultInfo) {
        // Real v4 shape: cursor in the envelope's result_info, no truncated.
        return ok(
          { buckets: page.map((name) => ({ name })) },
          ...(next < names.length ? [{ cursor: String(next) }] : [undefined]),
        );
      }
      return ok({
        buckets: page.map((name) => ({ name })),
        truncated: next < names.length,
        ...(next < names.length ? { cursor: String(next) } : {}),
      });
    }
    if (/^\/accounts\/[^/]+\/r2\/buckets$/.test(path) && method === "POST") {
      // Real shape: POST with `{name}`; an existing bucket conflicts.
      const name = (body as { name?: string })?.name;
      if (typeof name !== "string" || !name) return apiError(400, "bucket name is required");
      if (this.buckets.has(name)) return apiError(409, "bucket already exists");
      this.buckets.set(name, { objects: [] });
      return ok({});
    }
    m = path.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)$/);
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
