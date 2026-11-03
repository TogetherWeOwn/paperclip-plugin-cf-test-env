# Container credential broker threat model

## Status and release boundary

**Work in progress; container tools are not registered.** The current change adds
strict contracts, an application protocol client, an internal credential helper,
and an independent-approval evidence predicate. It does not yet provide an
operational container environment. The existing non-container tools and their
behavior are unchanged.

This document distinguishes implemented primitives from integration requirements.
Passing fixture tests is not proof of a live Cloudflare capability, an approved
artifact, a spend guarantee, or acceptance of the proposed approval path. Do not
install or expose container mutations until the integration requirements below
are satisfied and reviewed.

REA angle: the protocol follows the Cloudflare API schema and the shipped
Wrangler container client; approval boundaries follow the installed Paperclip
SDK and host implementation. Sources are listed below. No live Cloudflare calls,
credential minting, registry pushes, or live plugin configuration are needed for
these fixtures.

## Assets, actors and trust boundaries

- The existing company-scoped test-environment minting secret is the only held
  bootstrap credential. A production credential is outside this plugin's boundary.
- Containers Write is treated as **account-scoped**. No per-application token
  resource is assumed. The short-lived container credential must remain in broker
  memory and must not be returned to an agent, stored in plugin state, written to
  issue records, or logged. Only token IDs and recovery intent may be persisted.
- Agent input, workload code, image references, Cloudflare responses and provider
  diagnostics are untrusted. An environment name beginning with `pct-` is not
  ownership evidence.
- Company secret/config administrators, the host's authenticated company and
  agent context, and capability-scoped host RPC are trusted. A compromised host
  or an administrator replacing the bootstrap secret is outside this model.
- A permitted board principal can approve an exact operation. Membership alone
  does not confer that mandate: the reviewed routing policy supplies an explicit
  approver list. The evidence predicate does not attest physical human presence.

## Per-tool design

These names describe the proposed tools, not currently available registrations.
Each tool must reject additional keys at runtime as well as in its JSON schema.
No existing tool receives a new `action` or `containers` switch.

### `provision_container`

Inputs: `issueId`, optional integer `ttlSeconds` in the range 600–10800. No
account, Worker, application, namespace, route, zone, domain, D1, R2, AI, source,
command, metadata or credential input is accepted.

Threats: confused-deputy provisioning for another company/issue/owner; concurrent
capacity bypass; predictable-name overwrite; untracked partial creates; returning
an account credential or a Worker capability that defeats the trusted runtime.

Implemented primitive: exact input validation and durable-identity validation.
Required integration: authenticate the run, assert checkout ownership, verify the
current issue assignee/project/status and allow-list before secret access; reserve
capacity durably under serialization; preflight Worker absence; persist intent
and acknowledged resource IDs; verify uploaded Worker version, script tag, DO
class and namespace. Return a fixed non-secret result. **No Worker Admin token is
returned for a container environment.** A reservation alone is not a live env.

### `deploy_container`

Inputs: `envId`, `image`. The image must exactly equal the configured reviewed
`docker.io/cloudflare/sandbox@sha256:<64 lowercase hex>` artifact. Syntax does not
prove the artifact's version, contents or compatibility. Mutable tags, arbitrary
registries, commands, build contexts, URLs and configuration passthrough refuse.

Threats: account-wide credential escape; foreign application/namespace adoption;
unbounded scaling, networking or runtime; mutable-image substitution; replaying
approval after an image, generation, owner or policy change.

Implemented primitives:

- The scheduled API shape is `scheduling_policy: default`, `instances: 0`,
  `max_instances: 1`, `configuration.instance_type: lite`, one exact namespace,
  and the reviewed immutable image. It is not the distinct `durable_object`
  scheduling shape. Create response and independent GET must match the cap.
- Application ownership checks bind account ID, application name/ID and namespace.
  Ownership is checked separately from limits so an owned app with unsafe caps
  can still be removed. The acknowledged application ID is journaled before cap
  validation. Create ambiguity is an error, not permission to retry blindly.
- Token preflight requires the configured group ID, the exact official display
  name, account scope and `is_selectable: true`. The created token is journaled
  by ID and read back for one exact account policy, permission group, active
  status, name, validity interval and canonical IP-filter multiset before use.
  Lifetime is at most five minutes. No selectable group means no mint; it is not
  permission to add a different bootstrap credential.
- The credential helper gives its callback an application client, not a token
  string. Token values are held in JavaScript private fields/lexical memory, not
  enumerable object properties. It attempts revocation in `finally` and checks
  GET absence before recording revocation. A failed journal or uncertain
  revocation preserves a recovery obligation.

Required integration: enforce ownership/approval and single-use consumption
before minting or application calls; forbid replacement/overlapping rollout;
connect the resource journal and ambiguous-create/token recovery; pin and bundle
an actually reviewed compatible Sandbox runtime and its complete limits.

The public-image path transfers no OCI bytes and creates no managed registry
image. It requires no registry credential or image push. Managed registry cleanup
is not applicable to this path. Account-wide registry layer GC is explicitly not
an environment-scoped operation and must not be added to its cleanup.

### `teardown_container` — destructive

Input: `envId` only. No caller-selected resource IDs, `auto`, approval flags or
approval IDs. The manifest must mark this tool destructive when registered.

Threats: deleting an unrelated resource; reusing approval for a different env;
deleting a Worker first and leaving its application billing; treating an HTTP
DELETE success as proof of cleanup; dropping failed cleanup records.

Implemented primitive: read and check exact application ownership, DELETE that
ID, require GET absence and a complete cursor-paginated application inventory
with no matching resource. A matching name with a foreign namespace (or the
reverse) is a conflict, not an adopted cleanup target. Cyclic/invalid pagination,
duplicate matching IDs, malformed ownership metadata, or surviving applications
refuse completion.

Required integration: consume independently verified manual consent first;
quiesce the fixed runtime; delete and verify the application **before** deleting
its Worker/namespace; verify every remaining resource absent; retain the durable
record until all resource and token cleanup is verified. A protocol-client test
that never calls a Worker endpoint is not an end-to-end ordering test.

## Independent approval boundary

Installed SDK/host version: `2026.1023.0`.

Agent plugin calls traverse gateway policy checks, but native execute-on-approve
rejects plugin-provider actions with `approved_execution_unsupported`. The board
plugin execute route dispatches directly rather than through that policy.
Consequently, destructive annotations or a `require_approval` policy are
**defense in depth, not sufficient enforcement**. No live policy is changed here.

The proposed independent guard uses a broker-created interaction ID privately
pinned to an exact operation digest, generation, source run and ten-minute
expiry. The digest binds company, project, issue, owner, account, Worker tag,
namespace/application IDs, immutable image, absolute lifetime, operation, plugin
version, execution-policy digest and routed approver principals.

The implemented evidence predicate requires:

1. The exact pinned interaction, company, issue, source run, creator and custom
   target. Requested and effective policy must both be `human_only`.
2. Accepted status **and** an accepted typed result, before expiry, without an
   agent/run resolver or an already-consumed pin.
3. A currently active, non-viewer human membership for an explicitly permitted
   resolver, respecting any addressed user.
4. Positive matching host audit evidence with top-level `actorType: user`, the
   resolver's ID, exact issue/interaction and accepted status.

The last condition is essential: another plugin can relay an eligible user ID
through `respondInteraction`. Such a relay is audited as a plugin, so
`resolvedByUserId` alone is not independent authorization. Missing audit access,
a truncated search that does not find positive evidence, delayed audit writes,
capability denials and ambiguous records all refuse. The broker must never request
interaction-respond capability to approve its own action.

**Not yet implemented:** persistent pin storage, one-shot burn-before-execution,
serialization across lifecycle handlers/jobs/events, reviewed routing/config,
and acceptance of this path by Security. An accepted interaction by itself is
reusable and is not a consumption primitive. SDK `state.set` is an unconditional
upsert, not CAS. A process-local mutex cannot establish cross-process exclusion;
the single-writer deployment invariant or a host transactional claim must be
established before registration. Do not infer it merely from a configuration flag.

## Spend, lifetime and automatic cleanup

Release requirements remain: one instance, under $1 worst case within the
approved four-hour window, and teardown by T+3h. Identity validation bounds the
absolute environment lifetime to three hours; new deployment work closes five
minutes before that deadline. Reprovisioning/retry must not renew an existing env.
Cleanup credentials may be minted after env expiry because token expiry does not
stop billing.

**Not yet implemented or proven:** a fixed singleton DO/runtime with Internet
disabled, finite request/byte/runtime budgets, no caller-writable Worker entrypoint,
absolute-deadline stop alarm, frequent early-cleanup sweep, startup reconciliation
and an all-in spend calculation including Worker/DO, egress and logging charges.
One lite instance's compute estimate is not an all-in spend bound. Application
caps alone do not satisfy this requirement. An exposed endpoint's rejected
requests may still be billable and must be considered.

Automatic cleanup must be an internal lifecycle route derived from verified
expiry, terminal issue state or failed provisioning, not an agent-supplied
approval bypass. Its authority is limited to the journaled env. Provider outages
can prevent deletion; no alarm or sweep guarantees a control-plane deletion
instant during an outage. Preserve/alert on unresolved cleanup instead of claiming
absence, silently extending the authorized window or relaxing the spend scope.

## Failure and secret handling

- New protocol/credential/approval errors use fixed messages and do not retain
  provider bodies, transport exception causes or rejected inputs. Provider
  diagnostic strings must not cross the tool/log/card boundary.
- One shared lifecycle session stops all further Cloudflare calls on the first
  401, including revocation and rollback. A 403 is a step failure, not a dead
  credential. Concurrent lifecycle calls must be serialized before relying on
  this session-wide abort guarantee.
- Network failure, missing acknowledged ID, failed persistence, partial create,
  or failed absence verification leaves recovery work; it is not successful
  teardown. Token intent must be durable before POST, including ambiguous mints.
- Credential revocation failure overrides a success result. It must not clear
  recovery state or expose a token. The primitive does not yet implement recovery
  when token creation succeeds remotely but its ID response is lost.
- Existing non-container provider-error handling is unchanged. The new fixed
  messages are not a claim that the entire preexisting plugin is reflection-free.

## Fixture coverage and remaining acceptance tests

Current tests are local, injected-fetch fixtures. They cover strict per-tool
inputs; unknown capabilities; malformed IDs and lifetimes; immutable-image
refusals; exact namespace/application ownership and caps; journal-before-cap-check;
full inventory pagination; surviving resources after successful DELETE; fixed
error/secret-canary surfaces; selectable permission metadata; token policy,
IP/expiry read-back and revocation; first-401 abort; 403 handling; stale/replayed,
self-attributed or foreign approval; current membership and positive board-origin
audit evidence. No fixture uses real credentials or Cloudflare mutations.

Before release, add integration fixtures for authenticated handlers, company and
project isolation, actual reservation/consumption concurrency, full teardown
ordering, restart and ambiguous-create recovery, trusted runtime limits, forced
expiry/issue-close cleanup, and secret hygiene across captured logs, plugin state,
issue documents and every success/error tool result. Contract/protocol fixtures
alone do not satisfy those acceptance tests. Security review precedes QA review;
installation/configuration and live canary occur separately after merge.

## Source evidence

- [Cloudflare API schema](https://github.com/cloudflare/api-schemas/blob/dcba72008b225727cf717ad954788695a3374baf/openapi.json):
  scheduled application request, account-owned token permissions, `is_selectable`.
- [Wrangler container deployment](https://github.com/cloudflare/workers-sdk/blob/cff43aa3683f40a7244164d5c73ea425116bd281/packages/containers-shared/src/deploy.ts).
- [Worker/application deletion relationship](https://github.com/cloudflare/workers-sdk/blob/cff43aa3683f40a7244164d5c73ea425116bd281/packages/wrangler/src/containers/worker-applications.ts).
- [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
  and [limits](https://developers.cloudflare.com/containers/platform/limits/).
- Installed Paperclip host sources: `services/tool-gateway.js`,
  `routes/plugins.js`, `routes/issues.js`, `services/plugin-host-services.js`,
  `services/plugin-state-store.js`; SDK `dist/types.d.ts`. Relevant behaviors
  must be revalidated when the installed host/SDK version changes.
