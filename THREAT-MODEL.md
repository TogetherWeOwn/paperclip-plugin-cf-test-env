# Container credential broker threat model

## Status and release boundary

**Work in progress; container tools are not registered.** The current change adds
strict contracts, an application protocol client, an internal credential helper,
an independent-approval evidence predicate, a PostgreSQL coordination journal,
and current caller/checkout checks. It does not yet provide an operational
container environment. The existing non-container tools and their
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

Implemented primitives: exact input/durable-identity validation; current host
run/company/project/agent checks; authoritative issue assignee, project and
`in_progress` status; exact checkout run ownership; configuration and issue
rechecks after asynchronous checkout verification. The access helper has no
secret or HTTP capability. Its result is a current precondition, not a reusable
grant; the lifecycle must repeat it inside the claimed operation before secrets
or remote mutations. Fixed errors do not reflect host exceptions.

The PostgreSQL journal reserves one account-wide slot, not one slot per company.
Required integration: preflight Worker absence; connect intent and acknowledged
resource IDs to actual operations; verify uploaded Worker version, script tag,
DO class and namespace. Return a fixed non-secret result. **No Worker Admin token
is returned for a container environment.** A reservation alone is not a live env.

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
- Credential purpose, environment identity, CIDRs and recovery callbacks are
  captured before asynchronous preflight. Each application operation captures its
  own validated identity before yielding: later caller mutation cannot retarget
  a DELETE, a read-back or the original deployment cutoff.
- Broker-issued callback clients check the verified token expiry and original
  deployment cutoff before every request. Cleanup can run after env expiry, but
  only within its own verified credential lifetime. The callback client closes
  before revocation starts, including callback failure. A retained client cannot
  start later requests; invalid or backwards clocks refuse.

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

### Durable coordination primitive

The installed host also provides restricted PostgreSQL access through `ctx.db`.
The new journal uses one plugin-namespace table and parameterized single-statement
DML, not a direct connection from production plugin code. INSERT with ON CONFLICT
DO NOTHING reserves an account-wide slot. UPDATE compares both the expected
revision and the complete old document; only an affected-row count of exactly one
is a successful receipt. Zero means contention. Exceptions, missing capabilities,
wrong namespace and malformed receipts fail closed without an SDK-state fallback.

The journal stores the pin and permanently retains burned interaction IDs. After
host evidence verification and a fresh expiry check, approval consumption and
operation-claim acquisition happen in the same conditional UPDATE. The CAS baseline,
operation, attempt and policy are captured before asynchronous verification. Both
consent expiry and the deployment cutoff are checked again after the write receipt;
a slow write cannot extend either window. A failed, expired or lost commit reply
does not authorize a remote call or replay, even if a later read shows the claim.
The committed burn and claim are retained. These cases use real PostgreSQL fixtures.
Closed slots are retained: closing one env does not silently restart the cleared
PoC budget window. Journal facts have exact allowed keys; no provider responses,
arbitrary metadata, error strings or token values are stored.

Containers token facts require an approval-backed deploy/teardown claim, never the
unapproved provisioning claim. Credential intent, acknowledgement and verified
revocation must follow a consistent sequence. Unresolved intent or revocation
prevents successful completion and claim release. A live deployment additionally
requires an acknowledged application. Closing requires token-absence evidence after
the latest credential intent/acknowledgement, not a historical absence check.
These are journal progression guards, not independent proof of provider state:
lifecycle adapters still have to perform the actual read-back/absence operations.

Claims have **no automatic expiry or takeover**. A crash or ambiguous remote
outcome retains the claim instead of freeing capacity. A new process can read
that obligation but cannot steal it through this API. Stale-writer-safe recovery
and startup reconciliation remain unimplemented; a permanent lock is safe
exclusion, not sufficient availability or a working TTL cleanup system. Before
registration, every tool/job/event must use this journal and a recovery protocol
must settle potentially live previous writers and ambiguous provider calls.

A per-request journal read or time check is not provider-side fencing: a process
can pause after checking, and the provider can accept a request before its response
is lost. Database CAS, callback closure and credential expiry checks do not cancel
already dispatched requests or prove an old process cannot reach its bootstrap
credential. No recovery API may turn an inventory scan, a lease timeout or a
permanent claim into permission to resume creates. The stale-writer protocol must
settle those cases across process/host RPC boundaries before takeover is enabled.

The migration is present as source but its database declaration/capabilities are
not enabled yet. Runtime registration, persistent-host adapter integration,
reviewed approval routing/config, and Security acceptance remain release gates.
A PostgreSQL concurrency fixture does not prove these lifecycle properties. SDK
`state.set` remains an unconditional upsert and is not used as fake CAS.

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
  credential. The session refuses overlapping bootstrap/application requests and
  holds exclusion through response parsing; it does not queue calls behind a
  possible 401. Detached application work prevents a concurrent revocation receipt
  and causes lifecycle failure with retained recovery intent. This is process-local
  request exclusion, not cross-process operation fencing; all lifecycle entrypoints
  must still use durable claims.
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

Access fixtures additionally cover current run/checkout ownership, company and
project isolation, assignment/config changes during verification, expiry while
awaiting the host, and fixed errors before secret/HTTP access. Isolated PostgreSQL
fixtures use independent connections to exercise actual conditional reservation,
journal-write and approval-burn contention, foreign-company isolation, persisted
claims, lost commit replies and retained closed slots. CI requires these database
fixtures rather than silently skipping them.

Before release, add integration fixtures for the actual registered handlers,
full teardown ordering, stale-writer-safe restart and ambiguous-create recovery,
trusted runtime limits, forced expiry/issue-close cleanup, and secret hygiene
across captured logs, plugin state, issue documents and every success/error tool
result. Contract/protocol fixtures
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
