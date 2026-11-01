import { describe, expect, it } from "vitest";
import { CfClient, CfError } from "./cloudflare.js";
import { FakeCf } from "./test-support/fake-cf.js";

describe("CfClient", () => {
  it("round-trips workers, D1, KV, R2 and tokens through the fixture", async () => {
    const fake = new FakeCf();
    const cf = new CfClient(fake.fetch, "mint", "acct-1");
    const worker = await cf.createWorkerScript("pct-test-aaa");
    expect(worker.id).toBe("wid-pct-test-aaa");
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

  it("CfError carries status and body", () => {
    const err = new CfError(403, "forbidden", "nope");
    expect(err.status).toBe(403);
    expect(err.body).toBe("forbidden");
  });
});
