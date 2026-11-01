# paperclip-plugin-cf-test-env

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that gives agents
disposable Cloudflare test envs — one `pct-*` Worker plus its D1/KV/R2 — with
a per-Worker short-lived token, so agent test deploys run entirely
inside Paperclip with no way to touch production.

## Why this shape

The Cloudflare account also holds production Workers and data. A standing
account-wide "Workers Scripts Write" token could overwrite production, so:

- The plugin mints **account-owned tokens** carrying exactly two allowances:
  **Individual Workers Admin on ONE Worker id** (deploy, rollback, secret
  put/delete, delete that Worker) plus **R2 Bucket Item Write on ONE bucket**.
- D1 and KV have no per-resource roles (Cloudflare roadmap), so agents never
  get account-wide D1/KV write: D1 goes through the `d1_execute` tool, which
  the worker pins to the env's database id.
- Every token expires within ≤3 h and is IP-filtered to the host egress CIDR.

Rejected alternatives: Workers for Platforms ($25/mo), Paperclip's native
token broker (900 s cap, no issue context), a separate Cloudflare account.

## Tools

| tool | what it does |
|---|---|
| `provision(issueId, ttlSeconds?)` | Checks the caller is assigned to the issue, the project is allow-listed, and the concurrency cap holds. Creates stub Worker `pct-<issue>-<rand>` + D1/KV/R2, mints the scoped token (≤ max TTL, IP-filtered), stores a non-secret record on the card. Returns the token and account id for wrangler. |
| `d1_execute(envId, sql, params?)` | Runs SQL only on that env's D1. |
| `teardown(envId)` | Revokes the token first, then deletes Worker, D1, KV and R2 (bucket emptied first). Also runs automatically on `issue.updated` to done/cancelled; an hourly job sweeps expired or orphaned envs. |

## Configuration

| key | default | meaning |
|---|---|---|
| `tokenSecretRef` | `null` | Company secret binding for the minting credential (account-owned, IP-filtered, expiring). Unset means fail closed. |
| `accountId` | `""` | Cloudflare account id. Empty means fail closed. |
| `allowedProjectIds` | `[]` | Projects allowed to provision (Kofra first). Empty means fail closed. |
| `namePrefix` | `"pct-"` | Prefix for all provisioned names; the sweeper only touches this plugin's own state index. |
| `maxTtlSeconds` | `10800` | Token lifetime cap (3 h). |
| `maxConcurrentEnvs` | `10` | Live-env cap per company. |
| `egressCidr` | `""` | Host egress CIDR for the token `request.ip` filter. Empty means fail closed. |
| `workerAdminGroupId` / `r2ItemWriteGroupId` | `""` | Permission-group id overrides. Empty resolves the "Individual Workers Admin" / "Workers R2 Storage Bucket Item Write" names at provision time and fails closed when missing. |

## Capabilities

`agent.tools.register`, `http.outbound`, `secrets.read-ref`,
`events.subscribe`, `jobs.schedule`, `issues.read`,
`issue.documents.write`, `plugin.state.*`.

## Security notes

- The token value is not persisted by the plugin: it is returned in the tool
  result only, never written to plugin state or issue documents. It does
  appear in the run transcript, bounded by its short TTL and IP filter.
- Teardown revokes the token before deleting resources, so a leaked token
  dies even if deletion fails.
- Tests use an in-memory Cloudflare fixture (`src/test-support/fake-cf.ts`);
  no real Cloudflare calls run in CI.
- Canary (merge gate): the operator verifies a minted token can run
  `wrangler deploy` / `secret put` / `delete` on a stub Worker and gets 403 on
  production Workers. If the real API's per-Worker resource shape differs
  from `src/scoping.ts`, change only that file.

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
```

## License

MIT
