import { describe, expect, it } from "vitest";
import { assertContainerWorkerOwnership, CONTAINER_CLASS, ContainerRefusal, type ContainerIdentity } from "./container-contract.js";

const env: ContainerIdentity = {
  accountId: "a".repeat(32), companyId: "company", issueId: "issue", projectId: "project", ownerAgentId: "agent",
  envId: "pct-abcdef12-123456", workerName: "pct-abcdef12-123456", applicationName: "pct-abcdef12-123456",
  generation: 1, workerTag: "immutable-tag", namespaceId: "namespace",
  image: `docker.io/cloudflare/sandbox@sha256:${"a".repeat(64)}`,
  createdAt: "2026-11-03T12:00:00Z", expiresAt: "2026-11-03T15:00:00Z",
};
const versionId = "18f97339-c287-4872-9bdd-e2135c07ec12";
const binding = { name: "SANDBOX", type: "durable_object_namespace", class_name: CONTAINER_CLASS, namespace_id: env.namespaceId };
function evidence() {
  return {
    script: { id: env.workerName, tag: env.workerTag },
    version: { id: versionId, resources: { bindings: [{ ...binding }] } },
    deployments: { deployments: [{ strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] }] },
    namespace: { id: env.namespaceId, script: env.workerName, class: CONTAINER_CLASS },
  };
}
function check(parts: Record<string, unknown>, id = versionId, identity = env): void {
  assertContainerWorkerOwnership(parts.script, parts.version, parts.deployments, parts.namespace, identity, id);
}
function refuses(parts: Record<string, unknown>, id = versionId, identity = env): void {
  expect(() => check(parts, id, identity)).toThrow(ContainerRefusal);
}

describe("container Worker ownership evidence", () => {
  it("requires the script tag, pinned version, active deployment and independent namespace", () => {
    expect(check(evidence())).toBeUndefined();
    const parts = evidence();
    Object.assign(parts.version.resources.bindings[0]!, { script_name: env.workerName });
    expect(check(parts)).toBeUndefined();
  });

  it.each(["script", "version", "deployments", "namespace"])("refuses missing or malformed %s evidence", (key) => {
    for (const value of [undefined, null, [], {}, "secret-canary", true]) refuses({ ...evidence(), [key]: value });
  });

  it.each([{ id: "pct-foreign" }, { tag: "recreated-tag" }, { id: "production", tag: env.workerTag }])("refuses foreign script %j", (change) => {
    refuses({ ...evidence(), script: { ...evidence().script, ...change } });
  });

  it.each(["", "../foreign", "version?other", "x".repeat(129)])("refuses invalid pinned version %s", (id) => {
    refuses(evidence(), id);
  });

  it("does not confuse a version annotation with the immutable script tag", () => {
    refuses({ ...evidence(), script: { id: env.workerName, tags: [env.workerTag], annotations: { "workers/tag": env.workerTag } } });
  });

  it("refuses a different version even when its bindings match", () => {
    refuses({ ...evidence(), version: { ...evidence().version, id: "foreign-version" } });
  });

  it.each([
    [], [binding, binding], [{ ...binding, name: "OTHER" }], [{ ...binding, type: "service" }],
    [{ ...binding, class_name: "ForeignClass" }], [{ ...binding, namespace_id: "foreign-namespace" }],
    [{ ...binding, script_name: "production" }], [{ ...binding, script_name: null }],
    [{ ...binding, environment: "production" }], [{ ...binding, environment: "" }],
    [{ ...binding, dispatch_namespace: "dispatch" }], [{ ...binding, dispatch_namespace: null }],
    [binding, { name: "AI", type: "ai" }], [binding, { name: "R2", type: "r2_bucket" }],
    [binding, { name: "D1", type: "d1" }], [null],
  ].map((bindings) => ({ bindings })))("refuses nonlocal, missing or additional bindings $bindings", ({ bindings }) => {
    refuses({ ...evidence(), version: { id: versionId, resources: { bindings } } });
  });

  it.each([
    { id: "foreign" }, { script: "production" }, { class: "ForeignClass" },
    { preview: { id: "preview" } }, { dispatch_namespace: "dispatch" },
  ])("refuses foreign namespace evidence %j", (change) => {
    refuses({ ...evidence(), namespace: { ...evidence().namespace, ...change } });
  });

  it.each([
    [], [{ strategy: "percentage", versions: [] }],
    [{ strategy: "other", versions: [{ version_id: versionId, percentage: 100 }] }],
    [{ strategy: "percentage", versions: [{ version_id: "foreign-version", percentage: 100 }] }],
    [{ strategy: "percentage", versions: [{ version_id: versionId, percentage: 99 }] }],
    [{ strategy: "percentage", versions: [{ version_id: versionId, percentage: "100" }] }],
    [{ strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }, { version_id: "other", percentage: 0 }] }],
    [{ strategy: "percentage", versions: [{ version_id: "old", percentage: 100 }] }, ...evidence().deployments.deployments],
  ].map((deployments) => ({ deployments })))("refuses missing, split or noncurrent deployments $deployments", ({ deployments }) => {
    refuses({ ...evidence(), deployments: { deployments } });
  });

  it("ignores older deployment history rather than treating any matching version as current", () => {
    const parts = evidence();
    parts.deployments.deployments.push({ strategy: "percentage", versions: [{ version_id: "old", percentage: 100 }] });
    expect(check(parts)).toBeUndefined();
  });

  it("validates the durable identity before trusting matching evidence", () => {
    refuses(evidence(), versionId, { ...env, workerName: "production" });
    refuses(evidence(), versionId, { ...env, namespaceId: "../foreign" });
  });

  it("never returns or reflects provider metadata, even in errors", () => {
    const canary = "internal-token-canary";
    const parts = evidence();
    Object.assign(parts.script, { secret: canary });
    Object.assign(parts.version, { secret: canary });
    expect(check(parts)).toBeUndefined();
    parts.script.tag = canary;
    try {
      check(parts);
      throw new Error("Expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainerRefusal);
      expect(String(err)).not.toContain(canary);
      expect(JSON.stringify(err)).not.toContain(canary);
      expect((err as Error).stack).not.toContain(canary);
    }
  });
});
