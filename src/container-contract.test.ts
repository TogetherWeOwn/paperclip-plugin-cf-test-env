import { describe, expect, it } from "vitest";
import {
  CONTAINER_CLASS,
  CONTAINER_CLEANUP_LEAD_MS,
  ContainerRefusal,
  assertApprovedContainerImage,
  assertContainerActive,
  assertContainerApplication,
  assertContainerIdentity,
  assertContainerNamespace,
  buildContainerApplication,
  containerConsentKey,
  parseDeployContainerInput,
  parseProvisionContainerInput,
  parseTeardownContainerInput,
  type ContainerIdentity,
} from "./container-contract.js";

const image = `docker.io/cloudflare/sandbox@sha256:${"a".repeat(64)}`;
const env: ContainerIdentity = {
  accountId: "a".repeat(32),
  companyId: "company-1",
  issueId: "issue-1",
  projectId: "project-1",
  ownerAgentId: "agent-1",
  envId: "pct-abcdef12-123456",
  generation: 1,
  workerName: "pct-abcdef12-123456",
  workerTag: "tag-1",
  namespaceId: "namespace-1",
  applicationName: "pct-abcdef12-123456",
  applicationId: "app-1",
  image,
  createdAt: "2026-11-03T12:00:00Z",
  expiresAt: "2026-11-03T15:00:00Z",
};
const namespace = { id: env.namespaceId, script: env.workerName, class: CONTAINER_CLASS };
const application = { ...buildContainerApplication(env, image), id: env.applicationId, account_id: env.accountId };

function refuses(fn: () => unknown, code?: ContainerRefusal["code"]): void {
  try {
    fn();
    throw new Error("Expected a container refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(ContainerRefusal);
    if (code) expect((err as ContainerRefusal).code).toBe(code);
  }
}

describe("separate container input contracts", () => {
  it("normalizes only the three narrow input shapes", () => {
    expect(parseProvisionContainerInput({ issueId: "issue-1" })).toEqual({ issueId: "issue-1", ttlSeconds: 10800 });
    expect(parseProvisionContainerInput({ issueId: "issue-1", ttlSeconds: 600 })).toEqual({ issueId: "issue-1", ttlSeconds: 600 });
    expect(parseDeployContainerInput({ envId: env.envId, image })).toEqual({ envId: env.envId, image });
    expect(parseTeardownContainerInput({ envId: env.envId })).toEqual({ envId: env.envId });
  });

  it.each([NaN, Infinity, -Infinity, 0, -1, 1.5, 599, 10801, "600", null, undefined])("refuses invalid lifetime %s", (ttlSeconds) => {
    refuses(() => parseProvisionContainerInput({ issueId: "issue-1", ttlSeconds }), "invalid_input");
  });

  it.each([null, undefined, true, "issue-1", [], {}, { issueId: "" }])("refuses missing or non-object provision input %j", (input) => {
    refuses(() => parseProvisionContainerInput(input), "invalid_input");
  });

  it.each(["../production", "a/b", "%2fproduction", "a?x=1", "a#b", "a b", "a\n", "x".repeat(129)])("refuses unsafe path identity %j on all tools", (id) => {
    refuses(() => parseProvisionContainerInput({ issueId: id }));
    refuses(() => parseDeployContainerInput({ envId: id, image }));
    refuses(() => parseTeardownContainerInput({ envId: id }));
  });

  it.each([
    "action", "containers", "accountId", "workerName", "applicationId", "namespaceId", "className",
    "routes", "zones", "customDomains", "d1Id", "r2Bucket", "ai", "config", "metadata", "command",
    "buildContext", "url", "auto", "approval", "approved", "approvalId", "token",
  ])("refuses the unrecognized capability/key %s on each tool", (key) => {
    refuses(() => parseProvisionContainerInput({ issueId: "issue-1", [key]: true }), "invalid_input");
    refuses(() => parseDeployContainerInput({ envId: env.envId, image, [key]: true }), "invalid_input");
    refuses(() => parseTeardownContainerInput({ envId: env.envId, [key]: true }), "invalid_input");
  });

  it("does not trust inherited keys, accessors, symbols or prototype pollution", () => {
    refuses(() => parseProvisionContainerInput(Object.create({ issueId: "issue-1" })));
    refuses(() => parseTeardownContainerInput(JSON.parse('{"envId":"env","__proto__":{"auto":true}}')));
    const input = { get envId(): string { throw new Error("secret-canary"); } };
    refuses(() => parseTeardownContainerInput(input));
    refuses(() => parseTeardownContainerInput({ envId: env.envId, [Symbol("auto")]: true }));
  });

  it("never reflects secret-shaped rejected input in the error object", () => {
    const secrets = ["bootstrap-canary", "internal-canary", "registry-canary"];
    for (const secret of secrets) {
      try {
        parseDeployContainerInput({ envId: "env", image: secret });
        throw new Error("Expected refusal");
      } catch (err) {
        expect(err).toBeInstanceOf(ContainerRefusal);
        expect(String(err)).not.toContain(secret);
        expect(JSON.stringify(err)).not.toContain(secret);
        expect((err as Error).stack).not.toContain(secret);
      }
    }
  });
});

describe("reviewed immutable public Sandbox artifact", () => {
  it("accepts only the exact configured digest", () => {
    expect(() => assertApprovedContainerImage(image, image)).not.toThrow();
    refuses(() => assertApprovedContainerImage(image.replace(/a{64}$/, "b".repeat(64)), image), "unapproved_image");
    refuses(() => assertApprovedContainerImage(image, undefined), "unapproved_image");
  });

  it.each([
    "docker.io/cloudflare/sandbox:0.12.14", "docker.io/cloudflare/sandbox:latest",
    `docker.io/cloudflare/sandbox:0.12.14@sha256:${"a".repeat(64)}`,
    `https://docker.io/cloudflare/sandbox@sha256:${"a".repeat(64)}`,
    `docker.io/other/sandbox@sha256:${"a".repeat(64)}`,
    `registry.cloudflare.com/account/repo@sha256:${"a".repeat(64)}`,
    `docker.io/cloudflare/sandbox@sha256:${"A".repeat(64)}`,
    `docker.io/cloudflare/sandbox@sha256:${"a".repeat(63)}`,
    `${image}\n`, `${image}?url=https://example.com`, {}, null,
  ])("refuses mutable, foreign or malformed image %j", (candidate) => {
    refuses(() => parseDeployContainerInput({ envId: env.envId, image: candidate }), "unapproved_image");
    refuses(() => assertApprovedContainerImage(candidate, candidate), "unapproved_image");
  });
});

describe("tracked identity and absolute expiry", () => {
  it("validates the fixed env and closes mutations before the final deadline", () => {
    expect(() => assertContainerIdentity(env)).not.toThrow();
    const deadline = Date.parse(env.expiresAt) - CONTAINER_CLEANUP_LEAD_MS;
    expect(() => assertContainerActive(env, deadline - 1)).not.toThrow();
    refuses(() => assertContainerActive(env, deadline), "expired");
    refuses(() => assertContainerActive(env, deadline + 1), "expired");
    refuses(() => assertContainerActive(env, NaN), "expired");
    refuses(() => assertContainerActive(env, Date.parse(env.createdAt) - 1), "expired");
  });

  it.each(["workerName", "createdAt", "expiresAt"])("refuses non-string durable %s without coercion or reflection", (field) => {
    for (const value of [undefined, null, 123, { toString: () => { throw new Error("identity-secret-canary"); } }]) {
      refuses(() => assertContainerIdentity({ ...env, [field]: value }), "invalid_identity");
    }
  });

  it.each([
    { generation: 0 }, { generation: NaN }, { generation: 1.5 }, { companyId: "" }, { ownerAgentId: "" },
    { namespaceId: "../foreign" }, { workerTag: "a/b" }, { applicationId: "a?b" },
    { workerName: "production" }, { applicationName: "pct-other" }, { envId: "pct-other" },
    { createdAt: "invalid" }, { expiresAt: "2026-11-03T15:00:01Z" }, { expiresAt: "2026-11-03T12:09:59Z" },
  ])("refuses corrupted or broadened durable identity %j", (patch) => {
    refuses(() => assertContainerIdentity({ ...env, ...patch }), "invalid_identity");
  });
});

describe("Cloudflare scheduled request and ownership read-back", () => {
  it("builds just the public scheduled oneOf, with no pass-through config", () => {
    expect(buildContainerApplication(env, image)).toEqual({
      name: env.workerName,
      scheduling_policy: "default",
      instances: 0,
      max_instances: 1,
      configuration: { image, instance_type: "lite" },
      durable_objects: { namespace_id: env.namespaceId },
    });
    expect(() => assertContainerNamespace(namespace, env)).not.toThrow();
    expect(assertContainerApplication(application, env)).toBe("app-1");
  });

  it.each([
    { id: "foreign" }, { script: "pct-other" }, { class: "ForeignClass" }, { class: "" },
    { preview: true }, { preview: "false" }, { dispatch_namespace: "foreign" },
  ])("refuses namespace alias/preview/foreign class %j", (patch) => {
    refuses(() => assertContainerNamespace({ ...namespace, ...patch }, env), "ownership_mismatch");
  });

  it.each([
    { id: "foreign" }, { name: "pct-other" }, { durable_objects: { namespace_id: "foreign" } },
    { durable_objects: { script_name: env.workerName, class_name: CONTAINER_CLASS } },
    { durable_objects: null }, { id: "a/b" },
  ])("refuses foreign or malformed application identity %j", (patch) => {
    refuses(() => assertContainerApplication({ ...application, ...patch }, env), "ownership_mismatch");
  });

  it.each([
    { scheduling_policy: "durable_object" }, { scheduling_policy: "regional" }, { max_instances: 2 },
    { max_instances: undefined }, { max_instances: "1" }, { instances: 2 }, { instances: -1 }, { instances: NaN },
    { instances: 0.5 }, { configuration: { image, instance_type: "basic" } },
    { configuration: { image: "foreign", instance_type: "lite" } }, { configuration: null },
  ])("refuses changed sizing, scaling, image or scheduling %j", (patch) => {
    refuses(() => assertContainerApplication({ ...application, ...patch }, env), "cap_mismatch");
  });
});

describe("exact operation consent binding", () => {
  it("is stable for equal normalized identities and never serializes credentials", () => {
    const key = containerConsentKey(env, "deploy_container", "0.2.0");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(containerConsentKey({ ...env }, "deploy_container", "0.2.0")).toBe(key);
    expect(containerConsentKey(env, "teardown_container", "0.2.0")).not.toBe(key);
    expect(containerConsentKey(env, "deploy_container", "0.2.1")).not.toBe(key);
  });

  it.each([
    { companyId: "company-2" }, { issueId: "issue-2" }, { projectId: "project-2" },
    { ownerAgentId: "agent-2" }, { generation: 2 }, { workerTag: "tag-2" },
    { namespaceId: "namespace-2" }, { applicationId: "app-2" },
    { image: image.replace(/a{64}$/, "b".repeat(64)) },
    { expiresAt: "2026-11-03T14:59:00Z" },
  ])("invalidates consent on bound identity/input change %j", (patch) => {
    expect(containerConsentKey({ ...env, ...patch }, "deploy_container", "0.2.0"))
      .not.toBe(containerConsentKey(env, "deploy_container", "0.2.0"));
  });

  it("does not admit a generic operation or unversioned consent", () => {
    refuses(() => containerConsentKey(env, "auto" as "deploy_container", "0.2.0"), "invalid_input");
    refuses(() => containerConsentKey(env, "deploy_container", "latest"), "invalid_input");
  });
});
