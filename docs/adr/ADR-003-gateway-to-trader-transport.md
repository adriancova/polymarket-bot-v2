# ADR-003: Gateway-to-trader transport

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-060` (transport interface and Redis Streams adapter) —
  **not yet implemented**; consumed by `WP-120` and `WP-230`
- **Supersedes / Superseded by:** none

## Context

Handoff §2 locks the public market-data transport: "Bounded Redis Streams
transport in v1, **behind a transport interface**", and separately locks Redis as
"hot coordination … not for monetary truth". Handoff §9.1 states the publication
requirements. Handoff §4.2 defines what a transport outage must and must not do.

This ADR records the locked decision, the interface obligations that make the
v1 choice replaceable, and the failure semantics. It asserts **no venue
behavior**: the transport sits between our own gateway process and our own trader
process and has no Polymarket-facing surface.

## Decision

### 1. A transport interface, with Redis Streams as the v1 implementation

The gateway publishes normalized events through an interface, not through an
`ioredis` client. The interface supports exactly what §9.1 requires:

```text
publish
subscribe
consumer checkpoint
bounded retention
```

Redis Streams is the initial and only v1 implementation (`ioredis`, handoff
§2.1), and it lives in `packages/event-bus`. No other package imports a Redis
client for market-event transport (`docs/contracts/dependency-direction.md`).

Replacing Redis Streams, or adding a second transport, requires a new ADR. The
interface exists so that decision stays cheap, not so that it can be made
silently.

### 2. What the transport carries

The transport carries **normalized event envelopes** (ADR-002), not raw frames.
Raw frames go to the WAL (ADR-004), and §9.1 requires the raw frame to be
enqueued to the WAL writer **before** publication. The two paths are separate on
purpose: a transport outage must not cost recorded data.

Ordering: events remain ordered **per gateway epoch**. The transport must not
reorder within an epoch and must not merge two epochs into one apparent sequence
(ADR-002 §2).

### 3. Bounded, observable, never silently lossy

1. Every queue is bounded and exposes current depth, maximum depth, oldest
   message age, messages dropped, producer blocked time, and consumer lag
   (§8.3).
2. **Dropping trading or raw market events silently is forbidden** (§8.3). If a
   critical queue cannot accept an event, affected trading halts and a
   data-quality incident opens.
3. **Trader lag beyond configured retention is a hard resynchronization event,
   not silent catch-up from an incomplete stream** (§9.1). The consumer must
   detect that its checkpoint has fallen outside retention and raise a resync
   condition; it must not resume from the oldest surviving entry as though
   nothing were missing.
4. Consumer checkpoints are explicit, so a trader restart resumes from a known
   position within retention rather than from "now".

### 4. Failure semantics (handoff §4.2)

| Condition | Required behavior |
| --- | --- |
| Redis outage | Publication stops, and therefore **trading halts**. The recorder keeps writing WAL. |
| Trader deployment | Must not interrupt public data recording; the gateway keeps running across trader deploys (§9.1). |
| Consumer lag beyond retention | Hard resynchronization (see 3.3), including a new authoritative snapshot for affected markets (§7.1). |

Trading halting on a transport outage is the designed behavior, not a
degradation to work around. The trader must not fall back to reading the venue
directly, and must not continue on stale state.

### 5. Latency target, not a measured result

Handoff §9.1 sets a benchmark objective: gateway receipt-to-trader dispatch p99
**under 5 ms on the deployment host**. That is a target to be measured by
`WP-060`/`WP-120`/`WP-140`.

**No benchmark has been run.** Nothing in this repository may present the 5 ms
figure as an observed result.

### 6. Redis is not monetary truth, and not a fence

Redis holds streams, kill-switch state, health-lease state, and fencing state as
*hot coordination* (§2). It is not the ledger (ADR-006) and it is **not
sufficient as the only fence** for live order authority (§9.18, ADR-008).

## Consequences

- **A Redis outage is a trading outage.** That is accepted: the alternative — a
  trader that keeps deciding on an unknown data state — is worse. The recorder is
  deliberately decoupled so a Redis outage costs decisions, not data.
- **Retention size is a safety parameter, not a tuning knob.** Retention shorter
  than the worst tolerated trader restart converts an ordinary restart into a
  hard resync plus an authoritative-snapshot cycle.
- **The interface must not leak Redis semantics.** If consumer-group names,
  `XADD` ids, or `MAXLEN` trimming appear in a consumer's types, the transport is
  no longer replaceable and this ADR has been violated in substance while
  satisfied in form.
- **Two transports would double the ordering surface.** The single-transport rule
  keeps `(gatewayEpoch, ingestSeq)` the only ordering authority.
- **The p99 target is unproven.** If measurement shows it unreachable on the
  deployment host, the response is an ADR amendment with the evidence, not a
  quiet relaxation of the target.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §2 — "Bounded Redis Streams transport in v1, behind a transport interface";
  "Redis for streams, kill-switch state, health leases, and fencing—not for
  monetary truth".
- §2.1 — `ioredis` in the recommended operations libraries.
- §4.1 — process topology: `apps/data-gateway` continues running across trader
  deploys.
- §4.2 — failure boundaries: a Redis outage stops publication and therefore halts
  trading, but the recorder continues writing WAL; a trader deployment must not
  interrupt public data recording.
- §8.3 — bounded queues, the required metrics, and the prohibition on silent
  drops.
- §9.1 — publication requirements: transport interface with publish, subscribe,
  consumer checkpoint, and bounded retention; Redis Streams as the initial
  implementation; lag beyond retention is a hard resynchronization event;
  benchmark gateway-to-trader p99 with a target under 5 ms; raw frames enqueued to
  the WAL before publication.
- §9.18 — Redis is not sufficient as the only fence.
- §14.3 — latency metric family includes `gateway-to-trader`.

**Work plan** (`docs/spec/polymarket-bot-workplan.yaml`, `WP-060`): deliverables
"transport interface, Redis Streams publisher and consumer, consumer
checkpointing, lag and retention metrics"; acceptance "Ordered events remain
ordered per gateway epoch", "Reconnect resumes from checkpoint within retention",
"Lag beyond retention returns a hard resync condition".

**Venue facts:** none. This ADR makes no statement about Polymarket behavior. The
transport is internal, between `apps/data-gateway` and `apps/trader`.

**Safety:** this ADR changes no run-mode default (ADR-010). The transport carries
public market data and requires no credential.
