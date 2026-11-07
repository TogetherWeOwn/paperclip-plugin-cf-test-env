# Changelog

## 0.1.3

- Hourly cleanup uses company IDs delivered through the SDK configuration
  lifecycle, not global company enumeration from a scope-less cron job.
  Company IDs persist in plugin-owned state so automatic worker recovery does
  not disable cleanup; overlapping configuration deliveries are serialized.
  Failed registrations remain pending across later callbacks from any company.
  Config is refreshed per company at sweep time. Missing/corrupt registration
  and incomplete cleanup fail the job instead of silently reporting success;
  other configured companies still get their cleanup attempt. The unused
  `companies.read` capability is removed.

- Minted-token verification compares canonical CIDRs, not raw strings:
  Cloudflare may store the token `request.ip` condition with the IPv6
  network spelled differently (expanded groups, upper-case hex, leading
  zeros, host bits shown), which made `provision` revoke semantically
  identical tokens. Both sides are now parsed and normalized (lowercase,
  RFC 5952 compression, host bits masked to the prefix) before comparison;
  a genuinely different list — different network, prefix length, or count —
  still fails verification and revokes the token.

## 0.1.2

- Script uploads build the multipart body as a string with an
  explicit boundary (through `ctx.http.fetch` the plugin SDK `String()`s
  non-string bodies, so a `FormData` reached Cloudflare as the text
  `[object FormData]` and provision failed 415); every tool result now
  carries a record `data` plus readable `content` — including failures —
  so the MCP gateway never emits `structuredContent: null` and the agent
  sees the real error.
- Operator canary fixes: per-Worker token nests under
  `com.cloudflare.api.account.<acct>` keyed on the script `tag` (flat keys
  fail creation with `500 1004`); `createWorkerScript` returns the tag and
  fails closed without it; provision scopes the token to the tag, never the
  script name. R2 allowance stays flat. REST object PUT with the per-bucket
  token returns `10000` — documented as a known-bad path; wrangler-vs-S3 for
  agent R2 writes stays a follow-up canary question. Tag-less upload no
  longer leaks the Worker: `MissingWorkerTagError` carries the script name
  so provision deletes it by name (keeping the record for the sweep if that
  delete fails).

## 0.1.1

- Security review round 1: exact documented R2 per-bucket resource shape;
  owner/assignee + allow-list gate on `d1_execute` and agent-initiated
  `teardown`; provisioning record with rollback on partial provision (the
  sweep retries stale ones); idempotent teardown (404-tolerant deletes,
  paginated R2 emptying, per-object deletes); pre-create existence check,
  crypto randomness and prefix validation for Worker names; 3 h TTL clamp;
  required issue project; account-path permission groups as required config;
  tool schema sync.
- Devin round: rollback and sweep delete a Worker only when this provision
  created it (pre-existing Workers survive); R2 bucket existence check;
  `d1_execute`/agent `teardown` check the card's current project and tolerate
  pre-`ownerAgentId` records; permission-group config documented as required;
  lockfile version synced.

## 0.1.0

- Initial release: `provision` / `d1_execute` / `teardown` tools, `issue.updated`
  auto-teardown, hourly sweep of expired or orphaned `pct-*` envs.
- Per-Worker scoped short-lived tokens (Individual Workers Admin on one
  Worker id + R2 Bucket Item Write on one bucket, TTL ≤ 3 h, egress IP
  filter). D1 goes through `d1_execute` only.
