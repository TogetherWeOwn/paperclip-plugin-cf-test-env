# Changelog

## Unreleased

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
