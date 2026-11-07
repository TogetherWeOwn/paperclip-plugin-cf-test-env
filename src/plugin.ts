import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveConfig } from "./config.js";
import { d1Execute, handleIssueUpdated, provision, sweep, teardown } from "./envs.js";
import { D1_EXECUTE_TOOL, PROVISION_TOOL, SWEEP_JOB_KEY, TEARDOWN_TOOL } from "./manifest.js";

/**
 * Every tool result must carry a record `data` (plus readable `content`
 * and, on failure, the `error` string). The MCP gateway maps `data` to
 * `structuredContent`; when `data` is absent it becomes null and the
 * agent's MCP client rejects the whole result ("expected record, received
 * null"), so the real error never reaches the agent.
 */
function toolError(err: unknown): { error: string; data: { error: { message: string } }; content: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { error: message, data: { error: { message } }, content: `Error: ${message}` };
}

// The host replays stored company configs after startup. Keep only their IDs,
// not credentials or config snapshots; each sweep reads the current config.
const configuredCompanyIds = new Set<string>();

const plugin = definePlugin({
  multiCompanyConfig: true,
  async onConfigChanged(_config, context) {
    if (typeof context?.companyId === "string" && context.companyId.trim()) {
      configuredCompanyIds.add(context.companyId);
    }
  },
  async setup(ctx: PluginContext) {
    configuredCompanyIds.clear();
    ctx.tools.register(
      PROVISION_TOOL,
      {
        displayName: "Provision Cloudflare test env",
        description:
          "Create a disposable Cloudflare test env for the caller's card (pct-* Worker + D1/KV/R2, per-Worker short-lived token).",
        parametersSchema: {
          type: "object",
          properties: {
            issueId: { type: "string" },
            ttlSeconds: { type: "number" },
          },
          required: ["issueId"],
        },
      },
      async (params, runCtx) => {
        try {
          const config = resolveConfig(await ctx.config.get(runCtx.companyId));
          const input = (params ?? {}) as { issueId?: string; ttlSeconds?: number };
          if (typeof input.issueId !== "string" || !input.issueId) {
            return toolError(new Error("issueId is required."));
          }
          const result = await provision(ctx, config, runCtx, { issueId: input.issueId, ttlSeconds: input.ttlSeconds }, {
            fetchImpl: (url, init) => ctx.http.fetch(url, init),
          });
          // The token travels in the tool result only: never plugin state or
          // issue documents. It does appear in the run transcript, bounded by
          // its TTL and IP filter.
          return {
            data: result,
            content: [
              `Test env ${result.workerName} ready (expires ${result.expiresAt}).`,
              `CLOUDFLARE_API_TOKEN=<token from data> CLOUDFLARE_ACCOUNT_ID=${result.accountId}`,
              `Deploy with wrangler to worker ${result.workerName} only. Never touch other workers.`,
              `R2: do not PUT objects via REST with this token (rejected); agent R2 writes stay unverified.`,
            ].join("\n"),
          };
        } catch (err) {
          return toolError(err);
        }
      },
    );

    ctx.tools.register(
      D1_EXECUTE_TOOL,
      {
        displayName: "Run SQL on a test env D1",
        description: "Run SQL only on the D1 database of the given test env.",
        parametersSchema: {
          type: "object",
          properties: {
            envId: { type: "string" },
            sql: { type: "string" },
            params: {
              type: "array",
              description: "Optional bound parameters for the SQL.",
            },
          },
          required: ["envId", "sql"],
        },
      },
      async (params, runCtx) => {
        try {
          const config = resolveConfig(await ctx.config.get(runCtx.companyId));
          const input = (params ?? {}) as { envId?: string; sql?: string; params?: unknown[] };
          if (typeof input.envId !== "string" || !input.envId) return toolError(new Error("envId is required."));
          if (typeof input.sql !== "string" || !input.sql) return toolError(new Error("sql is required."));
          const rows = await d1Execute(ctx, config, runCtx, { envId: input.envId, sql: input.sql, params: input.params }, {
            fetchImpl: (url, init) => ctx.http.fetch(url, init),
          });
          return { data: { results: rows }, content: JSON.stringify(rows).slice(0, 4000) };
        } catch (err) {
          return toolError(err);
        }
      },
    );

    ctx.tools.register(
      TEARDOWN_TOOL,
      {
        displayName: "Tear down a Cloudflare test env",
        description: "Delete the env's Worker, D1, KV and R2 and revoke its token.",
        parametersSchema: {
          type: "object",
          properties: {
            envId: { type: "string" },
          },
          required: ["envId"],
        },
      },
      async (params, runCtx) => {
        try {
          const config = resolveConfig(await ctx.config.get(runCtx.companyId));
          const input = (params ?? {}) as { envId?: string };
          if (typeof input.envId !== "string" || !input.envId) return toolError(new Error("envId is required."));
          const { errors } = await teardown(
            ctx,
            config,
            runCtx.companyId,
            input.envId,
            {
              fetchImpl: (url, init) => ctx.http.fetch(url, init),
            },
            // Agent-initiated: enforce the owner/assignee + allow-list gate.
            { agentId: runCtx.agentId },
          );
          if (errors.length > 0) return toolError(new Error(`Teardown incomplete: ${errors.join("; ").slice(0, 1000)}`));
          return { data: { envId: input.envId, tornDown: true }, content: `Test env ${input.envId} torn down.` };
        } catch (err) {
          return toolError(err);
        }
      },
    );

    ctx.jobs.register(SWEEP_JOB_KEY, async () => {
      // Cron jobs carry no companyId. The SDK's onConfigChanged scope metadata
      // identifies companies authorized for proactive calls with explicit IDs.
      const companyIds = [...configuredCompanyIds];
      if (companyIds.length === 0) throw new Error("TTL sweep has not received any company configuration.");
      let failures = 0;
      for (const companyId of companyIds) {
        try {
          const config = resolveConfig(await ctx.config.get(companyId));
          if (!config.tokenSecretRef || !config.accountId) continue; // Unconfigured: fail closed.
          const result = await sweep(ctx, config, companyId, {
            fetchImpl: (url, init) => ctx.http.fetch(url, init),
          });
          const counts = { companyId, checked: result.checked, tornDown: result.tornDown.length, errors: result.errors.length };
          if (result.errors.length > 0) {
            failures += 1;
            ctx.logger.error("cf-test-env sweep incomplete", counts);
          } else {
            ctx.logger.info("cf-test-env sweep finished", counts);
          }
        } catch {
          failures += 1;
          ctx.logger.error("cf-test-env sweep failed", { companyId });
        }
      }
      // Keep other companies independent, but never report failed cleanup as a
      // successful job. Raw config/transport errors must not reach logs or jobs.
      if (failures > 0) throw new Error(`TTL sweep failed for ${failures} configured companies.`);
    });

    // Auto-teardown reads the card's authoritative status (not the event
    // payload shape): when it is done/cancelled — or unreadable — the card's
    // envs go away. Only envs recorded in this plugin's state are touched.
    ctx.events.on("issue.updated", async (event) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;
      try {
        const config = resolveConfig(await ctx.config.get(companyId));
        if (!config.tokenSecretRef || !config.accountId) return;
        const issue = await ctx.issues.get(issueId, companyId).catch(() => null);
        const status = (issue as { status?: string } | null)?.status;
        if (!issue || status === "done" || status === "cancelled") {
          await handleIssueUpdated(ctx, config, companyId, issueId, status ?? "cancelled", {
            fetchImpl: (url, init) => ctx.http.fetch(url, init),
          });
        }
      } catch (err) {
        ctx.logger.error("cf-test-env issue.updated handler failed", {
          companyId,
          issueId,
          error: String(err),
        });
      }
    });
  },
});

export default plugin;
