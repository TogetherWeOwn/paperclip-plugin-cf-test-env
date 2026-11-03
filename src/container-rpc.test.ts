import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { definePlugin, startWorkerRpcHost, type PluginContext } from "@paperclipai/plugin-sdk";
import { expect, it, vi } from "vitest";
import { ContainerApiSession, ContainerApplicationApi } from "./container-api.js";
import { buildContainerApplication, type ContainerIdentity } from "./container-contract.js";
import manifest from "./manifest.js";

it.each([200, 401])("quarantines an SDK timeout despite a later host %s reply; local timeout does not cancel host work", async (status) => {
  vi.useFakeTimers();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const messages: Array<{ id: string | number; method?: string; params?: unknown; result?: unknown }> = [];
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  let ctx!: PluginContext;
  const host = startWorkerRpcHost({
    plugin: definePlugin({
      setup: async (context) => { ctx = context; },
      onIdleDrain: async () => "none",
    }),
    stdin, stdout, rpcTimeoutMs: 10,
  });
  const send = (value: unknown) => stdin.write(`${JSON.stringify(value)}\n`);
  const rpc = async (id: string, method: string, params: unknown) => {
    const reply = once(lines, "line");
    send({ jsonrpc: "2.0", id, method, params });
    await reply;
    return messages.at(-1)!;
  };
  try {
    expect((await rpc("initialize", "initialize", { manifest, config: {} })).result).toMatchObject({ ok: true });
    const env: ContainerIdentity = {
      accountId: "a".repeat(32), companyId: "company", issueId: "issue", projectId: "project", ownerAgentId: "agent",
      envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456",
      generation: 1, workerTag: "tag", namespaceId: "namespace",
      image: `docker.io/cloudflare/sandbox@sha256:${"b".repeat(64)}`,
      createdAt: "2026-11-03T12:00:00Z", expiresAt: "2026-11-03T15:00:00Z",
    };
    const api = new ContainerApplicationApi(ctx.http.fetch, "fixture-internal-secret", env.accountId, new ContainerApiSession());
    const outbound = once(lines, "line");
    const journal = vi.fn(async () => undefined);
    const attempt = expect(api.create(env, env.image, journal)).rejects.toMatchObject({ code: "transport_failed" });
    await outbound;
    const request = messages.at(-1)!;
    expect(request.method).toBe("http.fetch");
    expect(request.params).toMatchObject({ init: { method: "POST" } });
    await vi.advanceTimersByTimeAsync(11);
    await attempt;
    expect(journal).not.toHaveBeenCalled();
    // The real SDK keeps a drain token after local timeout: no cancellation or
    // terminal provider receipt was sent through the wire.
    expect((await rpc("drain-before", "prepareIdleSleep", { ownerId: "test", expiresAt: Date.now() + 1000 })).result)
      .toMatchObject({ backgroundWork: "present" });
    expect(messages.filter((message) => message.method)).toEqual([request]);
    const denied = expect(api.findOwned(env)).rejects.toMatchObject({ code: "transport_failed" });
    await vi.advanceTimersByTimeAsync(11);
    await denied;
    expect(messages.filter((message) => message.method)).toEqual([request]);

    // The fixture host is free to finish the already accepted request later.
    send({ jsonrpc: "2.0", id: request.id, result: {
      status, statusText: status === 200 ? "OK" : "Unauthorized", headers: {},
      body: JSON.stringify({ success: true, result: { ...buildContainerApplication(env, env.image), id: "late-app" } }),
    } });
    expect((await rpc("drain-after", "prepareIdleSleep", { ownerId: "test", expiresAt: Date.now() + 1000 })).result)
      .toMatchObject({ backgroundWork: "none" });
    await rpc("release", "releaseIdleSleep", { ownerId: "test" });
    const retry = expect(api.findOwned(env)).rejects.toMatchObject({ code: "transport_failed" });
    await vi.advanceTimersByTimeAsync(11);
    await retry;
    expect(messages.filter((message) => message.method)).toEqual([request]);
    expect(journal).not.toHaveBeenCalled();
    host.stop();
    expect(messages.filter((message) => message.method)).toEqual([request]);
  } finally {
    host.stop();
    lines.close();
    stdin.destroy(); stdout.destroy();
    vi.useRealTimers();
  }
});
