import { describe, expect, it, vi } from "vitest";
import { ContainerApiError, ContainerApiSession, ContainerApplicationApi } from "./container-api.js";
import { buildContainerApplication, type ContainerIdentity } from "./container-contract.js";

const env: ContainerIdentity = {
  accountId: "a".repeat(32), companyId: "company", issueId: "issue", projectId: "project", ownerAgentId: "agent",
  envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456",
  generation: 1, workerTag: "worker-tag", namespaceId: "namespace", applicationId: "application",
  image: `docker.io/cloudflare/sandbox@sha256:${"b".repeat(64)}`,
  createdAt: "2026-11-03T12:00:00Z", expiresAt: "2026-11-03T15:00:00Z",
};
const app = { ...buildContainerApplication(env, env.image), id: env.applicationId, account_id: env.accountId };
const newEnv = { ...env, applicationId: undefined };
const internalToken = "internal-secret-canary";
const envelope = (result: unknown, result_info?: unknown): Response => Response.json({ success: true, result, ...(result_info ? { result_info } : {}) });
const absent = (): Response => new Response("not found", { status: 404 });
const inventory = (apps: unknown[] = [], next?: string): Response => envelope(apps, next ? { next_page_token: next } : {});

function fixture(responses: Array<Response | Error>) {
  const pending = [...responses];
  const fetch = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
    const response = pending.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected fixture call; no network is permitted");
    return response;
  });
  const session = new ContainerApiSession();
  const api = new ContainerApplicationApi(fetch, internalToken, env.accountId, session);
  return { api, fetch, session };
}

describe("container application protocol fixtures", () => {
  it("sends the scheduled create shape, journals the ID, then verifies stored limits", async () => {
    const { api, fetch } = fixture([envelope(app), envelope(app)]);
    const save = vi.fn(async () => undefined);
    expect(await api.create(newEnv, env.image, save)).toBe(env.applicationId);
    expect(save).toHaveBeenCalledExactlyOnceWith(env.applicationId);
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`https://api.cloudflare.com/client/v4/accounts/${env.accountId}/containers/applications`, "POST"],
      [`https://api.cloudflare.com/client/v4/accounts/${env.accountId}/containers/applications/${env.applicationId}`, "GET"],
    ]);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(buildContainerApplication(env, env.image));
    expect(fetch.mock.calls[0]![1]!.redirect).toBe("error");
  });

  it("journals an owned but unsafe create response before rejecting its cap", async () => {
    const { api, fetch } = fixture([envelope({ ...app, max_instances: 20 })]);
    const save = vi.fn(async () => undefined);
    await expect(api.create(newEnv, env.image, save)).rejects.toThrow("required limits");
    expect(save).toHaveBeenCalledExactlyOnceWith(env.applicationId);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses stored limit drift despite a correct create response", async () => {
    const { api } = fixture([envelope(app), envelope({ ...app, configuration: { image: env.image, instance_type: "basic" } })]);
    await expect(api.create(newEnv, env.image, async () => undefined)).rejects.toThrow("required limits");
  });

  it("does not adopt or journal a foreign application's ID", async () => {
    const { api } = fixture([envelope({ ...app, durable_objects: { namespace_id: "production" } })]);
    const save = vi.fn(async () => undefined);
    await expect(api.create(newEnv, env.image, save)).rejects.toThrow("ownership");
    expect(save).not.toHaveBeenCalled();
  });

  it("sanitizes journal errors and keeps the remote outcome ambiguous", async () => {
    const { api, fetch } = fixture([envelope(app)]);
    await expect(api.create(newEnv, env.image, async () => { throw new Error(internalToken); }))
      .rejects.toMatchObject({ code: "journal_failed", message: "Container application journal update failed; recovery is required." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses foreign accounts and invalid IDs before any outbound call", async () => {
    const { api, fetch } = fixture([]);
    await expect(api.readOwned({ ...env, accountId: "b".repeat(32) })).rejects.toThrow(ContainerApiError);
    await expect(api.readOwned({ ...env, applicationId: "../production" })).rejects.toThrow("identity");
    await expect(api.readOwned(newEnv)).rejects.toThrow(ContainerApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("verifies application absence after DELETE and a full inventory", async () => {
    const { api, fetch } = fixture([envelope(app), envelope({}), absent(), inventory()]);
    await expect(api.deleteAndVerify(env)).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE", "GET", "GET"]);
    expect(fetch.mock.calls.every(([url]) => url.includes("/containers/applications"))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => url.includes("/workers/") || url.includes("/v2/gc/"))).toBe(false);
  });

  it("can delete an owned app with unsafe caps rather than leaving it billing", async () => {
    const { api } = fixture([envelope({ ...app, max_instances: 20 }), envelope({}), absent(), inventory()]);
    await expect(api.deleteAndVerify(env)).resolves.toBeUndefined();
  });

  it("does not treat DELETE success as verified absence", async () => {
    const { api, fetch } = fixture([envelope(app), envelope({}), envelope(app)]);
    await expect(api.deleteAndVerify(env)).rejects.toMatchObject({ code: "cleanup_unverified" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("handles already absent apps but still checks all inventory pages", async () => {
    const { api, fetch } = fixture([absent(), absent(), inventory([], "page/2?x=1"), inventory()]);
    await expect(api.deleteAndVerify(env)).resolves.toBeUndefined();
    expect(fetch.mock.calls[3]![0]).toContain("page_token=page%2F2%3Fx%3D1");
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("finds a surviving application on a later page", async () => {
    const { api } = fixture([absent(), absent(), inventory([], "two"), inventory([app])]);
    await expect(api.deleteAndVerify(env)).rejects.toMatchObject({ code: "cleanup_unverified" });
  });

  it("refuses a matching name on a foreign namespace and never deletes it", async () => {
    const { api, fetch } = fixture([envelope({ ...app, durable_objects: { namespace_id: "foreign" } })]);
    await expect(api.deleteAndVerify(env)).rejects.toThrow("ownership");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]!.method).toBe("GET");
  });

  it("refuses renamed or reidentified applications that still use the owned namespace", async () => {
    const { api } = fixture([inventory([{ ...app, name: "pct-other" }])]);
    await expect(api.findOwned(env)).rejects.toThrow("ownership");
  });

  it("does not confuse other accounts' applications with absence", async () => {
    const { api } = fixture([inventory([{ ...app, account_id: "b".repeat(32) }])]);
    await expect(api.findOwned(env)).rejects.toThrow("ownership");
  });

  it("ignores well-formed unrelated inventory entries", async () => {
    const { api } = fixture([inventory([
      { ...app, id: "unrelated", name: "unrelated", durable_objects: { namespace_id: "unrelated" } },
      { id: "non-do", name: "non-do" },
    ])]);
    expect(await api.findOwned(env)).toEqual([]);
  });

  it("rejects cyclic cursors instead of looping or claiming complete inventory", async () => {
    const { api, fetch } = fixture([inventory([], "same"), inventory([], "same")]);
    await expect(api.findOwned(env)).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { success: true, result: [] },
    { success: true, result: [], result_info: { next_page_token: 1 } },
    { success: true, result: [null], result_info: {} },
    { success: true, result: [app, app], result_info: {} },
  ])("does not prove absence from an incomplete inventory %j", async (body) => {
    const { api } = fixture([Response.json(body)]);
    await expect(api.findOwned(env)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("operation identity and request exclusion", () => {
  it("does not retarget deletion when the input changes during the ownership read", async () => {
    const input = { ...env };
    const { api, fetch } = fixture([envelope(app), envelope({}), absent(), inventory()]);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (init?.method === "GET") input.applicationId = "foreign-application";
      return response;
    });
    await expect(api.deleteAndVerify(input)).resolves.toBeUndefined();
    expect(fetch.mock.calls[1]![0].endsWith(`/applications/${env.applicationId}`)).toBe(true);
    expect(fetch.mock.calls.every(([url]) => !url.includes("foreign-application"))).toBe(true);
  });

  it("captures create identity before the journal callback yields", async () => {
    const input = { ...newEnv };
    const { api } = fixture([envelope(app), envelope(app)]);
    await expect(api.create(input, env.image, async () => {
      input.namespaceId = "foreign-namespace";
      input.image = `docker.io/cloudflare/sandbox@sha256:${"c".repeat(64)}`;
    })).resolves.toBe(env.applicationId);
  });

  it("refuses overlapping requests while the first response body is pending, then honors its 401", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const session = new ContainerApiSession();
    const api = new ContainerApplicationApi(fetch, internalToken, env.accountId, session);
    const first = api.readOwned(env);
    const second = new ContainerApplicationApi(fetch, internalToken, env.accountId, session);
    await expect(second.readOwned(env)).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(fetch).toHaveBeenCalledTimes(1);
    release(new Response(internalToken, { status: 401 }));
    await expect(first).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(second.readOwned(env)).rejects.toMatchObject({ code: "authentication_failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("holds request exclusion through response parsing, not only fetch", async () => {
    let release!: (text: string) => void;
    const response = envelope(app);
    vi.spyOn(response, "text").mockImplementation(() => new Promise<string>((resolve) => { release = resolve; }));
    const { api, fetch } = fixture([response]);
    const first = api.readOwned(env);
    // Let the response reach its asynchronous body reader.
    await Promise.resolve(); await Promise.resolve();
    await expect(api.readOwned(env)).rejects.toMatchObject({ code: "operation_in_progress" });
    release(JSON.stringify({ success: true, result: app }));
    await expect(first).resolves.toEqual({ id: env.applicationId });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("sanitized failures and first-401 circuit breaker", () => {
  it("aborts all subsequent calls across credentials on the first 401", async () => {
    const { api, fetch, session } = fixture([new Response(internalToken, { status: 401 })]);
    await expect(api.deleteAndVerify(env)).rejects.toMatchObject({ code: "authentication_failed", status: 401 });
    expect(session.authenticationFailed).toBe(true);
    await expect(api.readOwned(env)).rejects.toMatchObject({ code: "authentication_failed" });
    const other = new ContainerApplicationApi(fetch, "bootstrap-secret-canary", env.accountId, session);
    await expect(other.readOwned(env)).rejects.toMatchObject({ code: "authentication_failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats 403 as a step error, not dead credentials or verified absence", async () => {
    const { api, fetch, session } = fixture([new Response(internalToken, { status: 403 }), envelope(app)]);
    await expect(api.readOwned(env)).rejects.toMatchObject({ code: "cloudflare_failed", status: 403 });
    expect(session.authenticationFailed).toBe(false);
    expect(await api.readOwned(env)).toEqual({ id: env.applicationId });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => new Response(internalToken, { status: 500 }),
    () => new Response(internalToken, { status: 302 }),
    () => new Response(internalToken, { status: 200 }),
    () => Response.json({ success: false, errors: [{ message: internalToken }], result: app }),
    () => Response.json({ result: app, token: internalToken }),
    () => new Error(`request Authorization: Bearer ${internalToken}`),
  ])("does not keep provider echoes or transport errors in exceptions", async (response) => {
    const { api } = fixture([response()]);
    let failure: unknown;
    try { await api.readOwned(env); } catch (err) { failure = err; }
    expect(failure).toBeInstanceOf(ContainerApiError);
    expect(String(failure)).not.toContain(internalToken);
    expect(JSON.stringify(failure)).not.toContain(internalToken);
    expect((failure as Error).stack).not.toContain(internalToken);
    expect((failure as Error).cause).toBeUndefined();
  });

  it("returns only the ownership ID even when successful provider metadata contains secrets", async () => {
    const { api } = fixture([envelope({ ...app, token: internalToken, diagnostics: { authorization: internalToken } })]);
    const result = await api.readOwned(env);
    expect(result).toEqual({ id: env.applicationId });
    expect(JSON.stringify(result)).not.toContain(internalToken);
  });

  it("does not serialize the internal credential in the API client or session", () => {
    const { api, session } = fixture([]);
    expect(JSON.stringify(api)).toBe("{}");
    expect(JSON.stringify(session)).toBe("{}");
  });
});
