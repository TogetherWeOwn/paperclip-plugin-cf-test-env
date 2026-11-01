# Changelog

## 0.1.0

- Initial release: `provision` / `d1_execute` / `teardown` tools, `issue.updated`
  auto-teardown, hourly sweep of expired or orphaned `pct-*` envs.
- Per-Worker scoped short-lived tokens (Individual Workers Admin on one
  Worker id + R2 Bucket Item Write on one bucket, TTL ≤ 3 h, egress IP
  filter). D1 goes through `d1_execute` only.
