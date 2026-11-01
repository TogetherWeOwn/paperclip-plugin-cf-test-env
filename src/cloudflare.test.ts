import { describe, expect, it } from "vitest";
import { CfClient, CfError, MissingWorkerTagError, isAuthenticationFailure } from "./cloudflare.js";
import { FakeCf } from "./test-support/fake-cf.js";

describe("CfClient", () => {
  it("round-trips workers, D1, KV, R2 and tokens through the fixture", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    const worker = await cf.createWorkerScript("pct-test-aaa");
    // The real upload response carries id = script name plus a separate tag =
    // Worker ID; the per-Worker token is scoped to the tag.
    expect(worker.id).toBe("pct-test-aaa");
    expect(worker.tag).toBe("tag-pct-test-aaa");
    const d1 = await cf.createD1("pct-test-aaa");
    expect(await cf.d1Query(d1.uuid, "select 1")).toBeDefined();
    const kv = await cf.createNamespace("pct-test-aaa");
    await cf.createBucket("pct-test-aaa");
    const token = await cf.createAccountToken({ name: "t", policies: [] });
    expect(token.value).toMatch(/^secret-value-/);
    await cf.revokeAccountToken(token.id);
    expect(fake.revokedTokens).toEqual([token.id]);
    await cf.deleteWorkerScript("pct-test-aaa");
    await cf.deleteD1(d1.uuid);
    await cf.deleteNamespace(kv.id);
    await cf.deleteBucket("pct-test-aaa");
    expect(fake.scripts.size).toBe(0);
  });

  it("throws CfError with status on API failure", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    await expect(cf.d1Query("d1-missing", "select 1")).rejects.toMatchObject({ name: "CfError", status: 404 });
  });

  it("throws CfError on non-JSON responses", async () => {
    const cf = new CfClient(async () => new Response("not json", { status: 200 }), "mint", "acct-1");
    await expect(cf.createWorkerScript("x")).rejects.toMatchObject({ name: "CfError" });
  });

  it("resolves permission groups by name and fails closed when missing", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    expect(await cf.resolvePermissionGroupId("Individual Workers Admin", "")).toBe("grp-worker-admin");
    expect(await cf.resolvePermissionGroupId("anything", "override-id")).toBe("override-id");
    await expect(cf.resolvePermissionGroupId("No Such Role", "")).rejects.toThrow(/not found/);
  });

  it("groups a missing permission name as a failed mint, not a broad token", async () => {
    const fake = new FakeCf();
    fake.groups = [];
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    await expect(cf.resolvePermissionGroupId("Individual Workers Admin", "")).rejects.toThrow();
    expect(fake.tokens.size).toBe(0);
  });

  it("uploads Worker scripts as multipart form data, not JSON", async () => {
    let seen: RequestInit | undefined;
    const cf = new CfClient(async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ success: true, errors: [], result: { id: "pct-multi", tag: "tag-pct-multi" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }, "mint", "acct-1");
    const created = await cf.createWorkerScript("pct-multi");
    expect(created.tag).toBe("tag-pct-multi");
    expect(seen?.method).toBe("PUT");
    expect(seen?.body).toBeInstanceOf(FormData);
    // fetch sets the multipart boundary itself; a JSON content-type would
    // override it and the upload would be rejected.
    expect(JSON.stringify(seen?.headers ?? {})).not.toContain("application/json");
    const form = seen?.body as FormData;
    expect(form.has("metadata")).toBe(true);
  });

  it("lists R2 bucket names", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    expect(await cf.listBuckets()).toEqual([]);
    await cf.createBucket("pct-a");
    expect(await cf.listBuckets()).toEqual(["pct-a"]);
  });

  it("creates R2 buckets with POST and conflicts on duplicates", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    await cf.createBucket("pct-dup");
    const create = fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/r2/buckets"));
    expect(create?.body).toEqual({ name: "pct-dup" });
    await expect(cf.createBucket("pct-dup")).rejects.toMatchObject({ status: 409 });
  });

  it("follows every R2 list page so the collision pre-check sees all buckets", async () => {
    const fake = new FakeCf();
    for (let i = 0; i < 2500; i++) {
      fake.buckets.set(`pct-seed-${i}`, { objects: [] });
    }
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    const names = await cf.listBuckets();
    expect(names).toHaveLength(2500);
    const pages = fake.calls.filter((c) => c.method === "GET" && c.path.endsWith("/r2/buckets"));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.query).toContain("per_page=1000");
  });

  it("follows a cursor from result_info even when truncated is absent", async () => {
    // The real v4 list-buckets response paginates via the envelope's
    // result_info, not fields inside result.
    const fake = new FakeCf();
    fake.bucketListCursorViaResultInfo = true;
    for (let i = 0; i < 2500; i++) {
      fake.buckets.set(`pct-seed-${i}`, { objects: [] });
    }
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    expect(await cf.listBuckets()).toHaveLength(2500);
  });

  it("treats a non-JSON 404 as success on tolerant deletes", async () => {
    // Some edges answer 404 with an HTML body: still "already absent".
    const cf = new CfClient(
      async () => new Response("<html>not found</html>", { status: 404 }),
      "mint",
      "acct-1",
    );
    await cf.deleteWorkerScript("pct-gone");
    await cf.deleteBucket("pct-gone");
    await cf.deleteBucketObject("pct-gone", "k");
    await cf.revokeAccountToken("tok-gone");
  });

  it("still throws on non-JSON responses that are not tolerated 404s", async () => {
    const cf = new CfClient(
      async () => new Response("<html>oops</html>", { status: 500 }),
      "mint",
      "acct-1",
    );
    await expect(cf.deleteWorkerScript("pct-x")).rejects.toMatchObject({ status: 500 });
  });

  it("deletes slash-containing keys with literal separators, not %2F", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    await cf.createBucket("pct-slash");
    fake.buckets.set("pct-slash", { objects: ["uploads/x.png", "plain"] });
    await cf.deleteBucketObject("pct-slash", "uploads/x.png");
    expect(fake.buckets.get("pct-slash")?.objects).toEqual(["plain"]);
    // The request path keeps `/` as the separator between key segments.
    const del = fake.calls.find((c) => c.method === "DELETE" && c.path.includes("/objects/"));
    expect(del?.path).toContain("/objects/uploads/x.png");
    expect(del?.path).not.toContain("%2F");
  });

  it("CfError carries status and body", () => {
    const err = new CfError(403, "forbidden", "nope");
    expect(err.status).toBe(403);
    expect(err.body).toBe("forbidden");
  });

  it("flags only 401 as an authentication failure that stops all further calls", () => {
    expect(isAuthenticationFailure(new CfError(401, "unauthorized", "nope"))).toBe(true);
    // A 403 is a resource-specific permission problem, not a dead credential:
    // callers record it and continue instead of aborting the sweep.
    expect(isAuthenticationFailure(new CfError(403, "forbidden", "nope"))).toBe(false);
    expect(isAuthenticationFailure(new CfError(404, "missing", "nope"))).toBe(false);
    expect(isAuthenticationFailure(new CfError(500, "boom", "nope"))).toBe(false);
    expect(isAuthenticationFailure(new Error("boom"))).toBe(false);
  });

  it("preserves a 401 status through malformed JSON envelopes", async () => {
    // The stop-on-401 guarantee rides on status preservation: a 401 with a
    // null, non-object or null-entry errors payload must still surface as
    // CfError(401), not a TypeError that cleanup treats as an ordinary error.
    for (const body of ["null", JSON.stringify({ errors: {} }), JSON.stringify({ errors: [null] })]) {
      const cf = new CfClient(async () => new Response(body, { status: 401 }), "mint", "acct-1");
      const err = await cf.createD1("pct-x").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CfError);
      expect((err as CfError).status).toBe(401);
      expect(isAuthenticationFailure(err)).toBe(true);
    }
  });

  it("preserves a 401 status through a malformed multipart-upload envelope", async () => {
    const cf = new CfClient(
      async () => new Response(JSON.stringify({ errors: [null] }), { status: 401 }),
      "mint",
      "acct-1",
    );
    const err = await cf.createWorkerScript("pct-x").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CfError);
    expect((err as CfError).status).toBe(401);
    expect(isAuthenticationFailure(err)).toBe(true);
  });

  it("reads worker metadata and returns null for missing scripts", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    expect(await cf.getWorkerScript("pct-missing")).toBeNull();
    await cf.createWorkerScript("pct-test-bbb");
    expect(await cf.getWorkerScript("pct-test-bbb")).toEqual({ id: "pct-test-bbb", tag: "tag-pct-test-bbb", name: "pct-test-bbb" });
    // Existence goes through the JSON settings sub-resource, never the
    // script-content endpoint (which returns the body, not JSON).
    expect(fake.calls.some((c) => c.method === "GET" && c.path.endsWith("/settings"))).toBe(true);
    expect(fake.calls.some((c) => c.method === "GET" && /\/scripts\/[^/]+$/.test(c.path))).toBe(false);
  });

  it("fails closed when the upload response has no script tag", async () => {
    // Scoping by script name is rejected by token creation (500 1004), so a
    // tag-less upload must never reach the mint step. The dedicated error
    // carries the script name so provision can delete the leaked Worker.
    const cf = new CfClient(
      async () =>
        new Response(JSON.stringify({ success: true, errors: [], result: { id: "pct-notag", name: "pct-notag" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      "mint",
      "acct-1",
    );
    const err = await cf.createWorkerScript("pct-notag").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MissingWorkerTagError);
    expect((err as MissingWorkerTagError).scriptName).toBe("pct-notag");
  });

  it("treats 404 on DELETE as success (idempotent teardown)", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    await cf.deleteWorkerScript("pct-gone");
    await cf.deleteD1("d1-gone");
    await cf.deleteNamespace("kv-gone");
    await cf.deleteBucket("pct-gone");
    await cf.revokeAccountToken("tok-gone");
    await cf.deleteBucketObject("pct-gone-bucket", "k");
  });

  it("paginates R2 listing with cursors and deletes per object", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    await cf.createBucket("pct-big");
    fake.buckets.set("pct-big", { objects: Array.from({ length: 2500 }, (_, i) => `k-${i}`) });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await cf.listBucketObjects("pct-big", cursor);
      seen.push(...page.objects.map((o) => o.key));
      if (!page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
    expect(seen).toHaveLength(2500);
    await cf.deleteBucketObject("pct-big", "k-0");
    expect(fake.buckets.get("pct-big")?.objects).toHaveLength(2499);
  });
});
