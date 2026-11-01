import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "togetherweown.cf-test-env";
export const PLUGIN_VERSION = "0.1.1";
export const SWEEP_JOB_KEY = "cf-env-sweep";

export const PROVISION_TOOL = "provision";
export const D1_EXECUTE_TOOL = "d1_execute";
export const TEARDOWN_TOOL = "teardown";

/** Document key on the owning card holding the non-secret env record. */
export const ENV_DOC_KEY = "cf-test-env";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Cloudflare Test Env",
  description:
    "Provisions per-card disposable Cloudflare test envs (pct-* Worker + D1/KV/R2) with per-Worker short-lived tokens, so agents run test deploys without touching production. Sweeps expired or orphaned envs hourly.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issue.documents.write",
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
    "events.subscribe",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: PROVISION_TOOL,
      displayName: "Provision Cloudflare test env",
      description:
        "Create a disposable Cloudflare test env for the caller's card: a pct-* Worker plus its D1/KV/R2, and a short-lived token scoped to that Worker only. The caller must be assigned to the issue and the project must be allow-listed. Returns the token and account id for wrangler. Never use for production Workers.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "UUID of the Paperclip issue the env belongs to. Must be assigned to the caller.",
          },
          ttlSeconds: {
            type: "number",
            description: "Requested token lifetime in seconds. Capped by maxTtlSeconds (default 3 h).",
          },
        },
        required: ["issueId"],
      },
    },
    {
      name: D1_EXECUTE_TOOL,
      displayName: "Run SQL on a test env D1",
      description:
        "Run SQL only on the D1 database of the given test env. Use this instead of any account-wide D1 access, which agents never get.",
      parametersSchema: {
        type: "object",
        properties: {
          envId: { type: "string", description: "Test env id returned by provision." },
          sql: { type: "string", description: "SQL to run on the env's D1 database." },
          params: {
            type: "array",
            description: "Optional bound parameters for the SQL.",
          },
        },
        required: ["envId", "sql"],
      },
    },
    {
      name: TEARDOWN_TOOL,
      displayName: "Tear down a Cloudflare test env",
      description:
        "Delete the Worker's script, D1, KV and R2 of the given test env and revoke its token. Runs automatically when the owning card closes; call it early when the env is no longer needed.",
      parametersSchema: {
        type: "object",
        properties: {
          envId: { type: "string", description: "Test env id returned by provision." },
        },
        required: ["envId"],
      },
    },
  ],
  jobs: [
    {
      jobKey: SWEEP_JOB_KEY,
      displayName: "Sweep expired Cloudflare test envs",
      description:
        "Hourly: tear down tracked envs whose token expired, whose owning card is done/cancelled or unreadable, and stale in-progress provisions. Only touches envs recorded in this plugin's own state index.",
      schedule: "0 * * * *",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      tokenSecretRef: {
        type: "object",
        description:
          "Company secret binding for the minting credential (account-owned API token with Account API Tokens Write, Workers Admin, D1/KV/R2 write). Only the ref is stored; the value is never logged.",
      },
      accountId: {
        type: "string",
        default: "",
        description: "Cloudflare account id holding the test envs (and production — tokens are per-Worker scoped so they cannot touch it).",
      },
      allowedProjectIds: {
        type: "array",
        items: { type: "string" },
        default: [],
        description: "Project UUIDs allowed to provision test envs (Kofra first). Empty disables provisioning (fail closed).",
      },
      namePrefix: {
        type: "string",
        default: "pct-",
        description: "Prefix for all provisioned resource names (Worker, D1, KV, R2). The sweeper only touches this prefix.",
      },
      maxTtlSeconds: {
        type: "number",
        default: 10800,
        description: "Maximum token lifetime in seconds (default 3 h). Requests above it are rejected.",
      },
      maxConcurrentEnvs: {
        type: "number",
        default: 10,
        description: "Maximum live envs per company. Provisioning beyond it is rejected.",
      },
      egressCidrs: {
        type: "array",
        items: { type: "string" },
        default: [],
        description:
          "Host egress CIDRs for the token request.ip filter (IPv4 /32 AND IPv6 /64 — a host egressing over both needs both, or every call on the missing family 401s and repeated 401s lock the caller out). Empty disables provisioning (fail closed).",
      },
      egressCidr: {
        type: "string",
        default: "",
        description:
          "Deprecated single-CIDR alias, merged into egressCidrs. Prefer egressCidrs.",
      },
      workerAdminGroupId: {
        type: "string",
        default: "",
        description: "Required: Cloudflare permission group id for Individual Workers Admin. Empty disables provisioning (fail closed); never looked up by name at runtime.",
      },
      r2ItemWriteGroupId: {
        type: "string",
        default: "",
        description: "Required: Cloudflare permission group id for Workers R2 Storage Bucket Item Write. Empty disables provisioning (fail closed); never looked up by name at runtime.",
      },
    },
  },
};

export default manifest;
