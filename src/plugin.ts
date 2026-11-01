import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveConfig } from "./config.js";
import { d1Execute, handleIssueUpdated, provision, sweep, teardown } from "./envs.js";
import { D1_EXECUTE_TOOL, PROVISION_TOOL, SWEEP_JOB_KEY, TEARDOWN_TOOL } from "./manifest.js";

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
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
            return { error: "issueId is required." };
          }
          const result = await provision(ctx, config, runCtx, { issueId: input.issueId, ttlSeconds: input.ttlSeconds }, {
            fetchImpl: (url, init) => ctx.http.fetch(url, init),
          });
          // The token travels in the tool result only: never state, docs, or logs.
          return {
            data: result,
            content: [
              `Test env ${result.workerName} ready (expires ${result.expiresAt}).`,
              `CLOUDFLARE_API_TOKEN=<token from data> CLOUDFLARE_ACCOUNT_ID=${result.accountId}`,
              `Deploy with wrangler to worker ${result.workerName} only. Never touch other workers.`,
            ].join("\n"),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
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
          },
          required: ["envId", "sql"],
        },
      },
      async (params, runCtx) => {
        try {
          const config = resolveConfig(await ctx.config.get(runCtx.companyId));
          const input = (params ?? {}) as { envId?: string; sql?: string; params?: unknown[] };
          if (typeof input.envId !== "string" || !input.envId) return { error: "envId is required." };
          if (typeof input.sql !== "string" || !input.sql) return { error: "sql is required." };
          const rows = await d1Execute(ctx, config, runCtx, { envId: input.envId, sql: input.sql, params: input.params }, {
            fetchImpl: (url, init) => ctx.http.fetch(url, init),
          });
          return { data: rows, content: JSON.stringify(rows).slice(0, 4000) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
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
          if (typeof input.envId !== "string" || !input.envId) return { error: "envId is required." };
          const { errors } = await teardown(ctx, config, runCtx.companyId, input.envId, {
            fetchImpl: (url, init) => ctx.http.fetch(url, init),
          });
          if (errors.length > 0) return { error: `Teardown incomplete: ${errors.join("; ").slice(0, 1000)}` };
          return { content: `Test env ${input.envId} torn down.` };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    );

    ctx.jobs.register(SWEEP_JOB_KEY, async () => {
      for (const company of await ctx.companies.list()) {
        try {
          const config = resolveConfig(await ctx.config.get(company.id));
          if (!config.tokenSecretRef || !config.accountId) continue; // Unconfigured: fail closed.
          const result = await sweep(ctx, config, company.id, {
            fetchImpl: (url, init) => ctx.http.fetch(url, init),
          });
          ctx.logger.info("cf-test-env sweep finished", { companyId: company.id, ...result });
        } catch (err) {
          ctx.logger.error("cf-test-env sweep failed", { companyId: company.id, error: String(err) });
        }
      }
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
