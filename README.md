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
- Every token expires within ≤3 h and is IP-filtered to the host egress CIDRs (IPv4 and IPv6).

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
| `egressCidrs` | `[]` | Host egress CIDRs for the token `request.ip` filter — list every egress path (IPv4 /32 AND IPv6 /64). Empty means fail closed. A legacy single `egressCidr` string is merged in. |
| `workerAdminGroupId` / `r2ItemWriteGroupId` | `""` | Required permission-group ids ("Individual Workers Admin" / "Workers R2 Storage Bucket Item Write"). Empty means fail closed; never resolved by name at runtime. |

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
- A 401 (dead credential or an IP filter that misses an egress family) is
  never retried or looped over: rollback is skipped, teardown aborts its
  remaining calls, and the sweep stops, because Cloudflare locks the caller
  out after repeated authentication failures. A 403 is resource-specific and
  is recorded as an ordinary error so one forbidden resource neither aborts
  its env's remaining cleanup nor starves the rest of the sweep. This is why
  `egressCidrs` must cover both IPv4 and IPv6 — and why a blank entry is
  rejected instead of silently dropped.
- Tests use an in-memory Cloudflare fixture (`src/test-support/fake-cf.ts`);
  no real Cloudflare calls run in CI.
- Canary (merge gate, verified 2026-11-01): the operator verifies a minted
  token can run `wrangler deploy` / `secret put` / `delete` on a stub Worker
  and gets 403 on production Workers. The per-Worker allowance MUST nest
  under `com.cloudflare.api.account.<acct>` keyed on the script `tag` (the
  Worker ID — `id` is the script name); a flat key fails token creation with
  `500 1004`. The R2 allowance stays flat
  (`com.cloudflare.edge.r2.bucket.<acct>_default_<bucket>`). If a new canary
  shows the API shape drifted from `src/scoping.ts`, change only that file.
- R2 writes (canary 2026-11-01, open question): `PUT
  /accounts/<acct>/r2/buckets/<bucket>/objects/<key>` with the per-bucket
  token returns `10000 Authentication error` — the REST object endpoint
  rejects bucket-item tokens, so agents must NOT write objects via REST.
  Whether `wrangler r2 object put` or the S3-compatible endpoint (access key
  id = token id, secret = sha256(token value)) accepts this token is
  unverified — confirm in a follow-up canary before relying on agent-driven
  R2 writes. Provision/teardown empty and delete buckets with the minting
  credential, which is unaffected.

## Scheduled cleanup and company scope

Cron job contexts do not contain a company ID. The worker opts into the SDK's
`multiCompanyConfig` lifecycle and records only the company IDs delivered to
`onConfigChanged(config, { companyId })`. Paperclip replays stored company
configuration on activation and delivers later operator saves through that hook.
Automatic worker crash recovery does not replay those configurations, so the
registry is persisted in plugin-owned instance state (`cf-test-env:companies`)
and concurrent registrations are serialized. A failed registration remains pending
until a later configuration callback persists it, even if that callback belongs to
another company. It contains no configuration values or credentials and confers
no authority: the host still checks each company call.
The hourly job reads those persisted IDs and refreshes `ctx.config.get(companyId)`;
company state, issue lookups and secret resolution also pass explicit company IDs.
It never enumerates all companies or infers one from an agent's active invocation.

This follows the `PluginConfigChangeContext` / `PluginDefinition` contract in
`@paperclipai/plugin-sdk` (2026.1023.0 and 2026.1106.0,
`dist/define-plugin.d.ts`, sections `multiCompanyConfig` and `onConfigChanged`).
The 2026.1106.0 host's `plugin-loader` seeds proactive authorization from the
plugin's configured companies and replays their `configChanged` messages.
No new capability or SDK upgrade is required.

A job with no persisted company registration, or an unreadable/corrupt registry,
fails without reading company state or resolving credentials. A configured company
with an empty account or secret reference is skipped, as before. A company failure does not
stop other companies from being attempted, but any failed/incomplete cleanup
marks the job failed. Job errors and sweep logs expose counts, not raw
configuration or transport errors. After an operator upgrade, verify a scheduled
hourly run, not only a manual tool call; failed cleanup remains tracked for retry.

The registry is not an authoritative list of current authorizations. The SDK does
not expose that list or a company-removal signal, so a denied lookup never prunes
an ID: transient authorization failures must not hide tracked resources. Whole
company deletion can therefore leave a stale ID and keep jobs visibly failed,
although other companies are still attempted. Also, if the host's scope refresh
fails after a configuration save, registration cannot repair that authorization.
An operator must restore the host's configured-company scopes through the supported
configuration-save or full plugin-reactivation path; automatic crash recovery is
not a scope refresh. These lifecycle limits are not fixed by this plugin change.

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
```

## License

MIT
