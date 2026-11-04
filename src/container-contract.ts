import { createHash } from "node:crypto";
import { isValidWorkerName } from "./scoping.js";

export const CONTAINER_CLASS = "ContainerSandbox";
export const CONTAINER_MAX_TTL_SECONDS = 10800;
export const CONTAINER_CLEANUP_LEAD_MS = 5 * 60 * 1000;
export const CONTAINER_MIN_TTL_SECONDS = 600;
export const CONTAINER_MAX_INSTANCES = 1;
export const CONTAINER_INSTANCE_TYPE = "lite";

/** Only fixed messages cross the tool/log boundary; never reflect rejected input. */
export class ContainerRefusal extends Error {
  constructor(readonly code: "invalid_input" | "invalid_identity" | "unapproved_image" | "ownership_mismatch" | "cap_mismatch" | "expired") {
    super({
      invalid_input: "Invalid container tool input.",
      invalid_identity: "Invalid tracked container identity.",
      unapproved_image: "Container image is not the approved immutable artifact.",
      ownership_mismatch: "Container resource ownership could not be verified.",
      cap_mismatch: "Container application does not match the required limits.",
      expired: "Container environment has expired or is closing.",
    }[code]);
    this.name = "ContainerRefusal";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactInput(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw new ContainerRefusal("invalid_input");
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new ContainerRefusal("invalid_input");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ContainerRefusal("invalid_input");
  }
  // Tool inputs are JSON data, not executable objects with accessors.
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw new ContainerRefusal("invalid_input");
  }
  return value;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function requiredId(value: unknown): string {
  if (!safeId(value)) throw new ContainerRefusal("invalid_input");
  return value;
}

export interface ProvisionContainerInput {
  issueId: string;
  ttlSeconds: number;
}

export function parseProvisionContainerInput(value: unknown): ProvisionContainerInput {
  const input = exactInput(value, ["issueId"], ["ttlSeconds"]);
  const ttl = Object.hasOwn(input, "ttlSeconds") ? input.ttlSeconds : CONTAINER_MAX_TTL_SECONDS;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < CONTAINER_MIN_TTL_SECONDS || ttl > CONTAINER_MAX_TTL_SECONDS) {
    throw new ContainerRefusal("invalid_input");
  }
  return { issueId: requiredId(input.issueId), ttlSeconds: ttl };
}

export function parseDeployContainerInput(value: unknown): { envId: string; image: string } {
  const input = exactInput(value, ["envId", "image"]);
  if (!isImmutableSandboxImage(input.image)) throw new ContainerRefusal("unapproved_image");
  return { envId: requiredId(input.envId), image: input.image };
}

export function parseTeardownContainerInput(value: unknown): { envId: string } {
  const input = exactInput(value, ["envId"]);
  return { envId: requiredId(input.envId) };
}

/** This validates syntax only. The configured digest still requires artifact review. */
export function isImmutableSandboxImage(image: unknown): image is string {
  return typeof image === "string" && /^docker\.io\/cloudflare\/sandbox@sha256:[a-f0-9]{64}$/.test(image);
}

export function assertApprovedContainerImage(image: unknown, approvedImage: unknown): asserts image is string {
  if (!isImmutableSandboxImage(approvedImage) || image !== approvedImage) {
    throw new ContainerRefusal("unapproved_image");
  }
}

export interface ContainerIdentity {
  accountId: string;
  companyId: string;
  issueId: string;
  projectId: string;
  ownerAgentId: string;
  envId: string;
  generation: number;
  workerName: string;
  workerTag: string;
  namespaceId: string;
  applicationName: string;
  applicationId?: string;
  image: string;
  createdAt: string;
  expiresAt: string;
}

/** Validate durable identity too: state corruption must never construct an API path. */
export function assertContainerIdentity(env: ContainerIdentity): void {
  if (!env || typeof env.accountId !== "string" || !/^[a-f0-9]{32}$/.test(env.accountId)
    || ![env.companyId, env.issueId, env.projectId, env.ownerAgentId, env.envId, env.workerTag, env.namespaceId].every(safeId)
    || !Number.isSafeInteger(env.generation) || env.generation < 1
    || typeof env.workerName !== "string" || !isValidWorkerName(env.workerName) || !env.workerName.startsWith("pct-")
    || env.envId !== env.workerName || env.applicationName !== env.workerName
    || (env.applicationId !== undefined && !safeId(env.applicationId))
    || !isImmutableSandboxImage(env.image) || typeof env.createdAt !== "string" || typeof env.expiresAt !== "string") {
    throw new ContainerRefusal("invalid_identity");
  }
  const created = Date.parse(env.createdAt);
  const expires = Date.parse(env.expiresAt);
  const ttl = expires - created;
  if (!Number.isFinite(created) || !Number.isFinite(expires)
    || ttl < CONTAINER_MIN_TTL_SECONDS * 1000 || ttl > CONTAINER_MAX_TTL_SECONDS * 1000) {
    throw new ContainerRefusal("invalid_identity");
  }
}

export function assertContainerActive(env: ContainerIdentity, nowMs: number): void {
  assertContainerIdentity(env);
  if (!Number.isFinite(nowMs) || nowMs < Date.parse(env.createdAt)
    || nowMs >= Date.parse(env.expiresAt) - CONTAINER_CLEANUP_LEAD_MS) {
    throw new ContainerRefusal("expired");
  }
}

export interface ScheduledContainerRequest {
  name: string;
  scheduling_policy: "default";
  instances: 0;
  max_instances: 1;
  configuration: { image: string; instance_type: "lite" };
  durable_objects: { namespace_id: string };
}

/** Public OpenAPI scheduled oneOf only; no arbitrary config or legacy sizing keys. */
export function buildContainerApplication(env: ContainerIdentity, approvedImage: string): ScheduledContainerRequest {
  assertContainerIdentity(env);
  assertApprovedContainerImage(env.image, approvedImage);
  return {
    name: env.applicationName,
    scheduling_policy: "default",
    instances: 0,
    max_instances: CONTAINER_MAX_INSTANCES,
    configuration: { image: env.image, instance_type: CONTAINER_INSTANCE_TYPE },
    durable_objects: { namespace_id: env.namespaceId },
  };
}

/** A name prefix alone proves nothing: require the exact script/class/id tuple. */
export function assertContainerNamespace(value: unknown, env: ContainerIdentity): void {
  assertContainerIdentity(env);
  if (!isRecord(value) || value.id !== env.namespaceId || value.script !== env.workerName
    || value.class !== CONTAINER_CLASS || (value.preview !== undefined && value.preview !== false)
    || (value.dispatch_namespace !== undefined && value.dispatch_namespace !== null)) {
    throw new ContainerRefusal("ownership_mismatch");
  }
}

/**
 * Pure evidence check, not a freshness/authorization grant. The lifecycle must
 * read each record from its account/script-scoped endpoint under writer exclusion.
 * The deployments endpoint orders the actively serving deployment first.
 */
export function assertContainerWorkerOwnership(
  script: unknown,
  version: unknown,
  deployments: unknown,
  namespace: unknown,
  env: ContainerIdentity,
  versionId: string,
): void {
  assertContainerIdentity(env);
  if (!safeId(versionId) || !isRecord(script) || script.id !== env.workerName || script.tag !== env.workerTag
    || !isRecord(version) || version.id !== versionId || !isRecord(version.resources)
    || !Array.isArray(version.resources.bindings) || version.resources.bindings.length !== 1) {
    throw new ContainerRefusal("ownership_mismatch");
  }
  const binding: unknown = version.resources.bindings[0];
  if (!isRecord(binding) || binding.name !== "SANDBOX" || binding.type !== "durable_object_namespace"
    || binding.class_name !== CONTAINER_CLASS || binding.namespace_id !== env.namespaceId
    || (binding.script_name !== undefined && binding.script_name !== env.workerName)
    || binding.environment !== undefined || binding.dispatch_namespace !== undefined) {
    throw new ContainerRefusal("ownership_mismatch");
  }
  assertContainerNamespace(namespace, env);
  if (!isRecord(deployments) || !Array.isArray(deployments.deployments)) {
    throw new ContainerRefusal("ownership_mismatch");
  }
  const latest: unknown = deployments.deployments[0];
  if (!isRecord(latest) || latest.strategy !== "percentage" || !Array.isArray(latest.versions) || latest.versions.length !== 1) {
    throw new ContainerRefusal("ownership_mismatch");
  }
  const active: unknown = latest.versions[0];
  if (!isRecord(active) || active.version_id !== versionId || active.percentage !== 100) {
    throw new ContainerRefusal("ownership_mismatch");
  }
}

/** Ownership is separate from limits so an owned, misconfigured app can be cleaned up. */
export function assertOwnedContainerApplication(value: unknown, env: ContainerIdentity): asserts value is Record<string, unknown> & { id: string } {
  assertContainerIdentity(env);
  if (!isRecord(value) || !safeId(value.id) || value.name !== env.applicationName
    || value.account_id !== env.accountId
    || (env.applicationId !== undefined && value.id !== env.applicationId)
    || !isRecord(value.durable_objects) || value.durable_objects.namespace_id !== env.namespaceId) {
    throw new ContainerRefusal("ownership_mismatch");
  }
}

/** Read-back must match ownership AND the remotely enforced policy/size/count. */
export function assertContainerApplication(value: unknown, env: ContainerIdentity): string {
  assertOwnedContainerApplication(value, env);
  if (value.scheduling_policy !== "default" || value.max_instances !== CONTAINER_MAX_INSTANCES
    || typeof value.instances !== "number" || !Number.isInteger(value.instances) || value.instances < 0 || value.instances > CONTAINER_MAX_INSTANCES
    || !isRecord(value.configuration) || value.configuration.image !== env.image
    || value.configuration.instance_type !== CONTAINER_INSTANCE_TYPE) {
    throw new ContainerRefusal("cap_mismatch");
  }
  return value.id;
}

export type ContainerOperation = "deploy_container" | "teardown_container";

/** Hash only normalized, operation-specific data, never caller-selected approval IDs. */
export function containerConsentKey(env: ContainerIdentity, operation: ContainerOperation, pluginVersion: string): string {
  assertContainerIdentity(env);
  if ((operation !== "deploy_container" && operation !== "teardown_container")
    || typeof pluginVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(pluginVersion)) {
    throw new ContainerRefusal("invalid_input");
  }
  return createHash("sha256").update(JSON.stringify({
    accountId: env.accountId,
    companyId: env.companyId,
    issueId: env.issueId,
    projectId: env.projectId,
    ownerAgentId: env.ownerAgentId,
    envId: env.envId,
    generation: env.generation,
    workerName: env.workerName,
    workerTag: env.workerTag,
    namespaceId: env.namespaceId,
    applicationName: env.applicationName,
    applicationId: env.applicationId ?? null,
    image: env.image,
    createdAt: env.createdAt,
    expiresAt: env.expiresAt,
    operation,
    pluginVersion,
  })).digest("hex");
}
