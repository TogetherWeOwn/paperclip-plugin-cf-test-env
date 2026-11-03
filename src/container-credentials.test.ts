import { describe, expect, it, vi } from "vitest";
import { ContainerApiSession, type ContainerApplicationApi } from "./container-api.js";
import { type ContainerIdentity } from "./container-contract.js";
import {
  assertInternalContainerToken, CONTAINERS_GROUP_NAME, ContainerCredentialBroker, ContainerCredentialError,
  containerTokenRequest, type ContainerCredentialJournal,
} from "./container-credentials.js";

const env: ContainerIdentity = {
  accountId: "a".repeat(32), companyId: "company", projectId: "project", issueId: "issue", ownerAgentId: "agent",
  envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456",
  generation: 1, workerTag: "tag", namespaceId: "namespace", image: `docker.io/cloudflare/sandbox@sha256:${"a".repeat(64)}`,
  createdAt: "2026-11-03T12:00:00Z", expiresAt: "2026-11-03T15:00:00Z",
};
const now = Date.parse("2026-11-03T12:01:00Z");
const groupId = "b".repeat(32);
const tokenId = "c".repeat(32);
const cidrs = ["192.0.2.7/32", "2001:db8::/64"];
const bootstrap = "bootstrap-secret-canary";
const internal = "internal-secret-canary";
const request = containerTokenRequest(env, groupId, cidrs, now, "deploy");
const stored = { ...request, id: tokenId, status: "active" };
const group = { id: groupId, name: CONTAINERS_GROUP_NAME, is_selectable: true, scopes: ["com.cloudflare.api.account"] };
const json = (result: unknown): Response => Response.json({ success: true, result });
const missing = (): Response => new Response("absent", { status: 404 });

function fixture(responses: Array<Response | Error>, clock: () => number = () => now) {
  const pending = [...responses];
  const fetch = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
    const response = pending.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected fixture request; live network is forbidden");
    return response;
  });
  const session = new ContainerApiSession();
  const broker = new ContainerCredentialBroker(fetch, bootstrap, env.accountId, session, clock);
  const events: unknown[] = [];
  const journal: ContainerCredentialJournal = {
    begin: vi.fn(async (name, expiresOn) => { events.push({ intent: name, expiresOn }); }),
    acknowledged: vi.fn(async (id) => { events.push({ id }); }),
    revoked: vi.fn(async (id) => { events.push({ revoked: id }); }),
  };
  const opts = { env, groupId, egressCidrs: cidrs, purpose: "deploy" as const, journal };
  return { fetch, session, broker, journal, opts, events };
}

const mintSequence = (): Response[] => [json([group]), json({ id: tokenId, value: internal }), json(stored)];
const revokeSequence = (): Response[] => [json({}), missing()];

function secretFree(value: unknown): void {
  const surfaces = [String(value), JSON.stringify(value), value instanceof Error ? value.stack ?? "" : ""];
  for (const surface of surfaces) {
    expect(surface).not.toContain(bootstrap);
    expect(surface).not.toContain(internal);
  }
}

describe("internal container token scope", () => {
  it("requests only one account Containers policy with a five-minute IP-filtered lifetime", () => {
    expect(request.policies).toEqual([{ effect: "allow", resources: { [`com.cloudflare.api.account.${env.accountId}`]: "*" }, permission_groups: [{ id: groupId }] }]);
    expect(request.condition).toEqual({ "request.ip": { in: cidrs } });
    expect(Date.parse(request.expires_on) - Date.parse(request.not_before)).toBe(300000);
    expect(() => assertInternalContainerToken(stored, tokenId, request, now)).not.toThrow();
  });

  it("allows cleanup after lifetime but not deployment or renewal", () => {
    const expired = Date.parse(env.expiresAt) + 1;
    expect(() => containerTokenRequest(env, groupId, cidrs, expired, "deploy")).toThrow("expired");
    expect(Date.parse(containerTokenRequest(env, groupId, cidrs, expired, "cleanup").expires_on)).toBeGreaterThan(expired);
    expect(env.expiresAt).toBe("2026-11-03T15:00:00Z");
  });

  it.each([[], [""], ["not a network"], ["192.0.2.7/33"], ["2001:db8::/129"]].map((egress) => ({ egress })))("refuses invalid or absent egress %j before minting", ({ egress }) => {
    expect(() => containerTokenRequest(env, groupId, egress, now, "deploy")).toThrow(ContainerCredentialError);
  });

  it.each([
    { id: "d".repeat(32) }, { name: "foreign" }, { status: "disabled" }, { status: "expired" },
    { expires_on: "invalid" }, { expires_on: "2026-11-03T12:06:01Z" }, { expires_on: "2026-11-03T12:01:00Z" },
    { not_before: "2026-11-03T12:00:59Z" }, { not_before: "2026-11-03T12:01:01Z" },
    { policies: [] }, { policies: [...request.policies, ...request.policies] },
    { policies: [{ ...request.policies[0], effect: "deny" }] },
    { policies: [{ ...request.policies[0], resources: { "com.cloudflare.api.account.*": "*" } }] },
    { policies: [{ ...request.policies[0], resources: { [`com.cloudflare.api.account.${env.accountId}`]: { "*": "*" } } }] },
    { policies: [{ ...request.policies[0], permission_groups: [{ id: "d".repeat(32) }] }] },
    { policies: [{ ...request.policies[0], permission_groups: [{ id: groupId }, { id: groupId }] }] },
    { condition: {} }, { condition: { request_ip: { in: cidrs } } },
    { condition: { "request.ip": { in: [...cidrs, "0.0.0.0/0"] } } },
    { condition: { "request.ip": { in: [cidrs[0]] } } },
    { condition: { "request.ip": { in: cidrs, not_in: [] } } },
  ])("refuses broadened/malformed stored token metadata %j", (patch) => {
    expect(() => assertInternalContainerToken({ ...stored, ...patch }, tokenId, request, now)).toThrow(ContainerCredentialError);
  });

  it("accepts equivalent CIDRs but rejects invalid clock or duplicates", () => {
    expect(() => assertInternalContainerToken({ ...stored, condition: { "request.ip": { in: ["2001:0db8:0:0::/64", "192.0.2.7"] } } }, tokenId, request, now)).not.toThrow();
    expect(() => assertInternalContainerToken(stored, tokenId, request, NaN)).toThrow(ContainerCredentialError);
    expect(() => assertInternalContainerToken({ ...stored, condition: { "request.ip": { in: [cidrs[0], cidrs[0]] } } }, tokenId, request, now)).toThrow(ContainerCredentialError);
  });
});

describe("in-memory credential lifecycle", () => {
  it("journals only IDs, uses the internal value for app calls, and revokes with read-back", async () => {
    const f = fixture([...mintSequence(), missing(), ...revokeSequence()]);
    const output = await f.broker.withApplicationApi(f.opts, async (api) => {
      expect(f.journal.acknowledged).toHaveBeenCalledExactlyOnceWith(tokenId);
      return { absent: await api.readOwned({ ...env, applicationId: "app" }) === null };
    });
    expect(output).toEqual({ absent: true });
    expect(f.fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET", "GET", "DELETE", "GET"]);
    expect(f.fetch.mock.calls[3]![1]!.headers).toMatchObject({ Authorization: `Bearer ${internal}` });
    expect(f.fetch.mock.calls[4]![1]!.headers).toMatchObject({ Authorization: `Bearer ${bootstrap}` });
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
    secretFree(output); secretFree(f.events); secretFree(f.broker);
    expect(JSON.stringify(f.broker)).toBe("{}");
  });

  it.each([
    null, [], [{ ...group, is_selectable: false }], [{ ...group, is_selectable: undefined }],
    [{ ...group, name: "Workers Scripts Write" }], [{ ...group, scopes: ["com.cloudflare.api.account.zone"] }],
    [{ ...group, scopes: ["com.cloudflare.api.account", "com.cloudflare.api.user"] }], [group, group],
  ].map((groups) => ({ groups })))("stops before minting when configured permission is unavailable %j", async ({ groups }) => {
    const f = fixture([json(groups)]);
    const run = vi.fn();
    await expect(f.broker.withApplicationApi(f.opts, run)).rejects.toMatchObject({ code: "permission_unavailable" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.journal.begin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not mint if intent cannot be stored", async () => {
    const f = fixture([json([group])]);
    f.journal.begin = async () => { throw new Error(bootstrap); };
    await expect(f.broker.withApplicationApi(f.opts, vi.fn())).rejects.toMatchObject({ code: "journal_failed" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("revokes an acknowledged ID even if journaling it fails", async () => {
    const f = fixture([json([group]), json({ id: tokenId, value: internal }), ...revokeSequence()]);
    f.journal.acknowledged = async () => { throw new Error(internal); };
    await expect(f.broker.withApplicationApi(f.opts, vi.fn())).rejects.toMatchObject({ code: "journal_failed" });
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
  });

  it("never invokes application operations with an unverified token", async () => {
    const f = fixture([json([group]), json({ id: tokenId, value: internal }), json({ ...stored, policies: [] }), ...revokeSequence()]);
    const run = vi.fn();
    await expect(f.broker.withApplicationApi(f.opts, run)).rejects.toMatchObject({ code: "verification_failed" });
    expect(run).not.toHaveBeenCalled();
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
  });

  it("skips revocation after application 401 and retains recovery ID", async () => {
    const f = fixture([...mintSequence(), new Response(internal, { status: 401 })]);
    await expect(f.broker.withApplicationApi(f.opts, (api) => api.readOwned({ ...env, applicationId: "app" })))
      .rejects.toMatchObject({ code: "authentication_failed" });
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.journal.acknowledged).toHaveBeenCalledExactlyOnceWith(tokenId);
    expect(f.journal.revoked).not.toHaveBeenCalled();
  });

  it("does not retry a bootstrap 401 or mint a credential", async () => {
    const f = fixture([new Response(bootstrap, { status: 401 })]);
    await expect(f.broker.withApplicationApi(f.opts, vi.fn())).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(f.broker.revokeAndVerify(tokenId, f.journal)).rejects.toMatchObject({ code: "authentication_failed" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("still attempts revocation after a 403 application failure", async () => {
    const f = fixture([...mintSequence(), new Response(internal, { status: 403 }), ...revokeSequence()]);
    await expect(f.broker.withApplicationApi(f.opts, (api) => api.readOwned({ ...env, applicationId: "app" })))
      .rejects.toMatchObject({ code: "cloudflare_failed", status: 403 });
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
  });

  it("requires independent absence verification before clearing token recovery state", async () => {
    const f = fixture([...mintSequence(), json({}), json(stored)]);
    await expect(f.broker.withApplicationApi(f.opts, async () => ({ ok: true }))).rejects.toMatchObject({ code: "revocation_unverified" });
    expect(f.journal.revoked).not.toHaveBeenCalled();
  });

  it("does not use a token that expired while the metadata request was in flight", async () => {
    let current = now;
    const f = fixture([...mintSequence(), ...revokeSequence()], () => current);
    const original = f.journal.acknowledged;
    f.journal.acknowledged = async (id) => { await original(id); current += 300001; };
    const run = vi.fn();
    await expect(f.broker.withApplicationApi(f.opts, run)).rejects.toMatchObject({ code: "verification_failed" });
    expect(run).not.toHaveBeenCalled();
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
  });

  it("revokes without deploying if mint verification crosses the environment cleanup cutoff", async () => {
    const cutoff = Date.parse(env.expiresAt) - 300000;
    let current = cutoff - 1000;
    const expected = containerTokenRequest(env, groupId, cidrs, current, "deploy");
    const f = fixture([
      json([group]), json({ id: tokenId, value: internal }), json({ ...expected, id: tokenId, status: "active" }),
      ...revokeSequence(),
    ], () => current);
    const original = f.journal.acknowledged;
    f.journal.acknowledged = async (id) => { await original(id); current = cutoff; };
    const run = vi.fn();
    await expect(f.broker.withApplicationApi(f.opts, run)).rejects.toMatchObject({ code: "expired" });
    expect(run).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(5);
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
    secretFree(f.events);
  });

  it.each([
    () => new Response(bootstrap, { status: 500 }),
    () => new Response(internal, { status: 200 }),
    () => Response.json({ result: [], errors: [{ message: bootstrap }] }),
    () => new Error(`Authorization: Bearer ${bootstrap}`),
  ])("sanitizes all upstream credential errors", async (response) => {
    const f = fixture([response()]);
    let failure: unknown;
    try { await f.broker.withApplicationApi(f.opts, vi.fn()); } catch (err) { failure = err; }
    expect(failure).toBeInstanceOf(Error);
    secretFree(failure); secretFree(f.events);
    expect((failure as Error).cause).toBeUndefined();
  });

  it("closes the callback client before returning, even when retained", async () => {
    const f = fixture([...mintSequence(), ...revokeSequence()]);
    let retained!: ContainerApplicationApi;
    await f.broker.withApplicationApi(f.opts, async (api) => { retained = api; });
    await expect(retained.readOwned({ ...env, applicationId: "app" })).rejects.toMatchObject({ code: "capability_expired" });
    expect(f.fetch).toHaveBeenCalledTimes(5);
  });

  it.each(["deploy", "cleanup"] as const)("checks the verified credential expiry on every %s application request", async (purpose) => {
    let current = now;
    const f = fixture([
      json([group]), json({ id: tokenId, value: internal }), json({ ...stored, expires_on: new Date(now + 1000).toISOString() }),
      ...revokeSequence(),
    ], () => current);
    await expect(f.broker.withApplicationApi({ ...f.opts, purpose }, async (api) => {
      current += 1000;
      return api.readOwned({ ...env, applicationId: "app" });
    })).rejects.toMatchObject({ code: "capability_expired" });
    expect(f.fetch).toHaveBeenCalledTimes(5);
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
  });

  it("does not let mutable options turn deployment into post-cutoff cleanup", async () => {
    const cutoff = Date.parse(env.expiresAt) - 300000;
    let current = cutoff - 1000;
    const expected = containerTokenRequest(env, groupId, cidrs, current, "deploy");
    const f = fixture([json([group]), json({ id: tokenId, value: internal }), json({ ...expected, id: tokenId, status: "active" }), ...revokeSequence()], () => current);
    const opts = { ...f.opts, env: { ...env }, purpose: "deploy" as "deploy" | "cleanup" };
    f.journal.begin = async () => { current = cutoff; opts.purpose = "cleanup"; };
    const run = vi.fn();
    await expect(f.broker.withApplicationApi(opts, run)).rejects.toMatchObject({ code: "expired" });
    expect(run).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("captures recovery callbacks before the intent write awaits", async () => {
    const f = fixture([...mintSequence(), ...revokeSequence()]);
    const acknowledged = f.journal.acknowledged;
    const revoked = f.journal.revoked;
    f.journal.begin = async () => {
      f.journal.acknowledged = vi.fn(async () => undefined);
      f.journal.revoked = vi.fn(async () => undefined);
    };
    await f.broker.withApplicationApi(f.opts, async () => undefined);
    expect(acknowledged).toHaveBeenCalledExactlyOnceWith(tokenId);
    expect(revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
  });

  it("rechecks the original environment cutoff inside the callback before each request", async () => {
    const cutoff = Date.parse(env.expiresAt) - 300000;
    let current = cutoff - 1000;
    const expected = containerTokenRequest(env, groupId, cidrs, current, "deploy");
    const f = fixture([json([group]), json({ id: tokenId, value: internal }), json({ ...expected, id: tokenId, status: "active" }), ...revokeSequence()], () => current);
    const opts = { ...f.opts, env: { ...env } };
    await expect(f.broker.withApplicationApi(opts, async (api) => {
      current = cutoff;
      opts.env.expiresAt = "2026-11-03T15:01:00Z";
      return api.readOwned({ ...env, applicationId: "app" });
    })).rejects.toMatchObject({ code: "expired" });
    expect(f.fetch).toHaveBeenCalledTimes(5);
  });

  it("allows cleanup application calls after environment expiry within their own credential window", async () => {
    const current = Date.parse(env.expiresAt) + 1000;
    const expected = containerTokenRequest(env, groupId, cidrs, current, "cleanup");
    const f = fixture([
      json([group]), json({ id: tokenId, value: internal }), json({ ...expected, id: tokenId, status: "active" }),
      missing(), ...revokeSequence(),
    ], () => current);
    await expect(f.broker.withApplicationApi({ ...f.opts, purpose: "cleanup" }, (api) => api.readOwned({ ...env, applicationId: "app" }))).resolves.toBeNull();
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
  });

  it.each([NaN, Infinity, now - 1])("refuses invalid or backwards time inside the callback: %s", async (time) => {
    let current = now;
    const f = fixture([...mintSequence(), ...revokeSequence()], () => current);
    await expect(f.broker.withApplicationApi(f.opts, async (api) => {
      current = time;
      return api.readOwned({ ...env, applicationId: "app" });
    })).rejects.toMatchObject({ code: "capability_expired" });
    expect(f.fetch).toHaveBeenCalledTimes(5);
  });

  it("does not report success or revocation while detached application work is unresolved", async () => {
    const f = fixture(mintSequence());
    const original = f.fetch.getMockImplementation()!;
    let release!: (response: Response) => void;
    f.fetch.mockImplementation((url, init) => url.includes("/containers/")
      ? new Promise<Response>((resolve) => { release = resolve; }) : original(url, init));
    let detached!: Promise<unknown>;
    let retained!: ContainerApplicationApi;
    await expect(f.broker.withApplicationApi(f.opts, async (api) => {
      retained = api;
      detached = api.readOwned({ ...env, applicationId: "app" });
    })).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(f.journal.revoked).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(4);
    release(missing());
    await expect(detached).resolves.toBeNull();
    await expect(retained.readOwned({ ...env, applicationId: "app" })).rejects.toMatchObject({ code: "capability_expired" });
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it("blocks bootstrap revocation while an internal-token request can still return 401", async () => {
    const f = fixture(mintSequence());
    const original = f.fetch.getMockImplementation()!;
    let release!: (response: Response) => void;
    f.fetch.mockImplementation((url, init) => url.includes("/containers/")
      ? new Promise<Response>((resolve) => { release = resolve; }) : original(url, init));
    await expect(f.broker.withApplicationApi(f.opts, async (api) => {
      const pending = api.readOwned({ ...env, applicationId: "app" });
      await expect(f.broker.revokeAndVerify(tokenId, f.journal)).rejects.toMatchObject({ code: "operation_in_progress" });
      release(new Response(internal, { status: 401 }));
      return pending;
    })).rejects.toMatchObject({ code: "authentication_failed" });
    expect(f.journal.revoked).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it("sanitizes unexpected application callback failures before revoking", async () => {
    const f = fixture([...mintSequence(), ...revokeSequence()]);
    let failure: unknown;
    try { await f.broker.withApplicationApi(f.opts, async () => { throw new Error(internal); }); } catch (err) { failure = err; }
    expect(failure).toMatchObject({ code: "operation_failed" });
    secretFree(failure);
    expect(f.journal.revoked).toHaveBeenCalledExactlyOnceWith(tokenId);
  });
});
