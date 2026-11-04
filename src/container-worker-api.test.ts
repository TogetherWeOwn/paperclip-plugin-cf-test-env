import { describe, expect, it, vi } from "vitest";
import { ContainerApiSession, ContainerApplicationApi } from "./container-api.js";
import type { ContainerIdentity } from "./container-contract.js";
import { ContainerWorkerApi } from "./container-worker.js";

const env: ContainerIdentity = {
  accountId: "a".repeat(32), companyId: "company", issueId: "issue", projectId: "project", ownerAgentId: "agent",
  envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456",
  generation: 1, workerTag: "tag", namespaceId: "namespace", image: `docker.io/cloudflare/sandbox@sha256:${"a".repeat(64)}`,
  createdAt: "2026-11-03T12:00:00Z", expiresAt: "2026-11-03T15:00:00Z",
};
const base = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/workers`;
const token = "WORKER_BOOTSTRAP_SECRET_CANARY";
const json = (result: unknown, info?: unknown) => Response.json({ success: true, result, ...(info === undefined ? {} : { result_info: info }) });
const namespace = (id = env.namespaceId, script = env.workerName) => ({ id, script, class: "ContainerSandbox" });
const page = (items: unknown[], number = 1, totalPages = 1, totalCount = items.length) => json(items, { page: number, per_page: 1000, count: items.length, total_pages: totalPages, total_count: totalCount });
function fixture(session = new ContainerApiSession(), current: () => void = () => undefined) {
  const responses: (Response | Error)[] = [
    json([{ id: env.workerName, tag: env.workerTag, metadata: token }, { id: "production", tag: "foreign" }]),
    json({ id: "version", resources: { bindings: [{ name: "SANDBOX", type: "durable_object_namespace", class_name: "ContainerSandbox", namespace_id: env.namespaceId }] } }),
    page([namespace()]),
    json({ deployments: [{ strategy: "percentage", versions: [{ version_id: "version", percentage: 100 }] }] }),
  ];
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("No live network in fixtures");
    return response;
  });
  const api = new ContainerWorkerApi(fetch, token, env.accountId, session, current);
  const invoke = () => api.verifyOwned(env, "version");
  return { api, session, responses, fetch, invoke };
}

describe("container Worker evidence HTTP adapter", () => {
  it("fetches metadata, pinned version, independent namespace and current deployment from supported fixed paths", async () => {
    const f = fixture();
    await expect(f.invoke()).resolves.toBeUndefined();
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
      `${base}/scripts`, `${base}/scripts/${env.workerName}/versions/version`,
      `${base}/durable_objects/namespaces?page=1&per_page=1000`, `${base}/scripts/${env.workerName}/deployments`,
    ]);
    for (const [, init] of f.fetch.mock.calls) expect(init).toEqual({ method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
  });

  it("accepts a complete account-wide scripts inventory above the individual-response budget", async () => {
    const f = fixture();
    const scripts = Array.from({ length: 110 }, (_, i) => ({
      id: i === 0 ? env.workerName : `other-${i}`, tag: i === 0 ? env.workerTag : `tag-${i}`,
      tags: Array.from({ length: 10 }, (_, j) => `${i}-${j}-`.padEnd(1024, "x")),
    }));
    const response = json(scripts);
    expect(Buffer.byteLength(await response.clone().text(), "utf8")).toBeGreaterThan(1024 * 1024);
    f.responses[0] = response;
    await expect(f.invoke()).resolves.toBeUndefined();
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    { accountId: "b".repeat(32) }, { workerName: "production" }, { namespaceId: "../foreign" }, { workerTag: "tag?other" },
  ])("rejects invalid/foreign tracked identity before HTTP %j", async (change) => {
    const f = fixture();
    await expect(f.api.verifyOwned({ ...env, ...change }, "version")).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["../version", "", "x".repeat(129)])("rejects invalid version before HTTP %s", async (id) => {
    const f = fixture();
    await expect(f.api.verifyOwned(env, id)).rejects.toMatchObject({ code: "ownership_mismatch" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [], [{ id: env.workerName, tag: "recreated" }], [{ id: "production", tag: env.workerTag }],
    [{ id: env.workerName, tag: env.workerTag }, { id: env.workerName, tag: env.workerTag }],
    [{ id: env.workerName, tag: env.workerTag }, { id: "production", tag: env.workerTag }],
  ].map((scripts) => ({ scripts })))("refuses missing, recreated, duplicated or conflicting script tuples $scripts", async ({ scripts }) => {
    const f = fixture();
    f.responses[0] = json(scripts);
    await expect(f.invoke()).rejects.toMatchObject({ code: "ownership_mismatch" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ cursor: "next" }, { next_page_token: "next" }, { total_pages: 2 }, { total_count: 9 }])("refuses a partial script collection %j", async (info) => {
    const f = fixture();
    f.responses[0] = json([{ id: env.workerName, tag: env.workerTag }], info);
    await expect(f.invoke()).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("scans every namespace page even when ownership was found on the first", async () => {
    const f = fixture();
    f.responses.splice(2, 1, page([namespace()], 1, 2, 2), page([namespace("foreign", "other")], 2, 2, 2));
    await expect(f.invoke()).resolves.toBeUndefined();
    expect(f.fetch.mock.calls[3]![0]).toBe(`${base}/durable_objects/namespaces?page=2&per_page=1000`);
  });

  it("can find the namespace on a later page", async () => {
    const f = fixture();
    f.responses.splice(2, 1, page([namespace("foreign", "other")], 1, 2, 2), page([namespace()], 2, 2, 2));
    await expect(f.invoke()).resolves.toBeUndefined();
  });

  it.each(["duplicate-id", "extra-local", "recreated", "foreign-class", "missing"]) ("refuses namespace conflict %s, including on a later page", async (kind) => {
    const f = fixture();
    if (kind === "duplicate-id") f.responses.splice(2, 1, page([namespace()], 1, 2, 2), page([namespace()], 2, 2, 2));
    if (kind === "extra-local") f.responses.splice(2, 1, page([namespace()], 1, 2, 2), page([namespace("other")], 2, 2, 2));
    if (kind === "recreated") f.responses[2] = page([namespace(env.namespaceId, "production")]);
    if (kind === "foreign-class") f.responses[2] = page([{ ...namespace(), class: "Foreign" }]);
    if (kind === "missing") f.responses[2] = page([]);
    await expect(f.invoke()).rejects.toThrow();
  });

  it.each([
    { page: 0 }, { page: 2 }, { per_page: 20 }, { count: 0 }, { total_pages: "1" }, { total_pages: 101 },
    { total_pages: 0 }, { total_count: 0 }, { total_count: 2 }, { total_count: -1 }, { cursor: "next" },
  ])("rejects malformed/incomplete namespace pagination %j", async (change) => {
    const f = fixture();
    f.responses[2] = json([namespace()], { page: 1, per_page: 1000, count: 1, total_pages: 1, total_count: 1, ...change });
    await expect(f.invoke()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects changing totals or a repeated page instead of silently truncating", async () => {
    for (const info of [{ page: 1, total_pages: 2, total_count: 2 }, { page: 2, total_pages: 3, total_count: 3 }]) {
      const f = fixture();
      f.responses.splice(2, 1, page([namespace()], 1, 2, 2), json([namespace("foreign", "other")], { per_page: 1000, count: 1, ...info }));
      await expect(f.invoke()).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("supports documented pagination without optional totals, continuing until a short page", async () => {
    const f = fixture();
    const foreign = Array.from({ length: 1000 }, (_, i) => namespace(`foreign-${i}`, "other"));
    f.responses.splice(2, 1, json(foreign, { page: 1, per_page: 1000, count: 1000 }), json([namespace()], { page: 2, per_page: 1000, count: 1 }));
    await expect(f.invoke()).resolves.toBeUndefined();
  });

  it.each([0, 1, 2, 3])("stops all shared clients after the first 401 at request %s", async (at) => {
    const f = fixture();
    f.responses[at] = new Response(token, { status: 401 });
    await expect(f.invoke()).rejects.toMatchObject({ code: "authentication_failed" });
    const app = new ContainerApplicationApi(f.fetch, "internal", env.accountId, f.session);
    await expect(app.readOwned({ ...env, applicationId: "app" })).rejects.toMatchObject({ code: "authentication_failed" });
    expect(f.fetch).toHaveBeenCalledTimes(at + 1);
  });

  it("poisons the shared attempt only for actual rejected transport, not local guards", async () => {
    const f = fixture();
    f.responses[0] = new Error(token);
    await expect(f.invoke()).rejects.toMatchObject({ code: "transport_failed" });
    await expect(f.invoke()).rejects.toMatchObject({ code: "transport_failed" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const g = fixture(new ContainerApiSession(async () => { throw new Error("local refusal"); }));
    await expect(g.invoke()).rejects.toThrow("local refusal");
    expect(() => g.session.assertCallable()).not.toThrow();
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it.each([403, 404, 500])("fails closed on HTTP %s without reflecting provider errors", async (status) => {
    const f = fixture();
    f.responses[0] = new Response(token, { status });
    const err = await f.invoke().catch((error: Error) => error);
    expect(err).toMatchObject({ code: "cloudflare_failed", status });
    expect(String(err)).not.toContain(token);
    expect(JSON.stringify(err)).not.toContain(token);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response("not JSON"), new Response("x".repeat(16 * 1024 * 1024 + 1)), json(null),
    Response.json({ success: false, result: token }), Response.json({ success: true }), json([], "bad-info"),
  ])("rejects malformed or oversized evidence responses", async (response) => {
    const f = fixture();
    f.responses[0] = response;
    await expect(f.invoke()).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a valid scripts envelope above the separate UTF-8 collection budget", async () => {
    const f = fixture();
    f.responses[0] = json([{ id: env.workerName, tag: env.workerTag, metadata: "é".repeat(8_400_000) }]);
    await expect(f.invoke()).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 3])("retains the individual UTF-8 byte limit for evidence response %s", async (at) => {
    const f = fixture();
    const body = await (f.responses[at] as Response).json();
    f.responses[at] = Response.json({ ...body, metadata: "é".repeat(600_000) });
    await expect(f.invoke()).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.fetch).toHaveBeenCalledTimes(at + 1);
  });

  it("snapshots identity before awaits so mutation cannot retarget subsequent requests", async () => {
    const identity = { ...env };
    const f = fixture(new ContainerApiSession(async () => {
      identity.workerName = "production";
      identity.namespaceId = "foreign";
      identity.workerTag = "foreign";
    }));
    await expect(f.api.verifyOwned(identity, "version")).resolves.toBeUndefined();
    expect(f.fetch.mock.calls.map(([url]) => url).every((url) => !url.includes("production") && !url.includes("foreign"))).toBe(true);
  });

  it("rechecks capability after asynchronous dispatch guards and after the final response", async () => {
    let open = true;
    const current = () => { if (!open) throw new Error("expired"); };
    const f = fixture(new ContainerApiSession(async () => { open = false; }), current);
    await expect(f.invoke()).rejects.toThrow("expired");
    expect(f.fetch).not.toHaveBeenCalled();
    open = true;
    const g = fixture(new ContainerApiSession(), current);
    const fetch = g.fetch.getMockImplementation()!;
    g.fetch.mockImplementation(async (...args) => { const result = await fetch(...args); if (g.fetch.mock.calls.length === 4) open = false; return result; });
    await expect(g.invoke()).rejects.toThrow("expired");
    expect(g.fetch).toHaveBeenCalledTimes(4);
  });
});
