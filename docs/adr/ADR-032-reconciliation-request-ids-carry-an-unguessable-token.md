# ADR-032: Wallet-operation reconciliation request ids carry an unguessable token

- **Status:** **Accepted, 2026-10-02: ruled by the user.** The orchestrator
  asked whether these ids should carry an unguessable token, and recommended
  yes. The user ruled yes on 2026-10-02.
- **Date:** 2026-10-02
- **Recorded by:** `ADR031-ACCEPT`
- **Implemented by:** `WP-300c`, merged as `7e05702`, in `packages/inventory`.
  The composition round and `WP-290` owe the obligations in D3 to D6. They are
  not implemented yet.
- **Supersedes / Superseded by:** none. It records the design `WP-300c` built.
  It changes no code.
- **Handoff sections:** §9.14, §9.17, §12.4. **ADRs:** ADR-006 §8, ADR-010.
- **Finding it resolves:** `WP300C-J1`, from `WP-300c`'s round-1 review. The
  ruling discharges governance item G1 (`WP300C-R2-G1`, restated in rounds 3
  and 4).
- **Code cited:** `main` at `7e05702`, the `WP-300c` merge. There,
  `packages/inventory` is identical to `1322b89`, the candidate both of
  `WP-300c`'s verifiers accepted.

## Context

1. **What a request is.** When a wallet operation's outcome is unknown,
   `WalletOperationManager` asks the reconciler for an authoritative read
   (§9.17; ADR-006 §8). It hands a `ReconciliationRequest` to the injected
   `ReconciliationRequester`. The answer comes back through
   `resolveByReconciliation`. It names the request it reports a read for, as
   `requestId`.
2. **What the binding protects.** The manager refuses an answer whose request
   was issued before evidence that could make its read wrong
   (`WALLET_OP_EVIDENCE_SUPERSEDED`). So an answer bound to too new a request
   can conclude an operation on a stale read. A conclusion can release
   reservations, or make an approval ready.
3. **The hazard, `WP300C-J1`.** At `WP-300c`'s base, `28d542a`, a request id
   was `compositeKey("wallet-op", operationId, "reconciliation", n)`, where
   `n` is the operation's request count. Anyone who knew the operation could
   predict the next id. `WP-300c`'s round-1 review reproduced this sequence:
   1. the operation is RECONCILING under request 1;
   2. a read is prepared for the predicted request 2, and held back;
   3. a contradicting observation makes the manager issue request 2;
   4. the held read is delivered, naming request 2.

   The held read was bound to request 2. A SPLIT read as FAILED concluded and
   released its reserved collateral. An `APPROVE_ERC20` or `APPROVE_ERC1155`
   read as CONFIRMED became ready after an allowance sync. The same read bound
   to request 1 was refused as superseded.
4. **Why the id itself must change.** Since `WP-300c`, the manager binds an
   answer only to a request the reconciler had received before the manager
   began reading that answer (D7). That rule alone does not refuse
   `WP300C-J1`: the reconciler had received request 2 before the held read
   arrived. The manager cannot see when the reconciler made its read, because
   an answer carries no read time. A deterministic id cannot help either.
   Whoever knows the operation and its request count can compute the next
   one.
5. **The layer.** `packages/inventory` is a layer-1 package
   (`docs/contracts/dependency-direction.md`). Its `index.ts` header says "No
   I/O, no clock, no randomness". `packages/polymarket-public` takes an
   injected id source for the same reason. Its `connectionId: () => string` is
   "Injected because generating one needs randomness, and a package that
   reached for `crypto.randomUUID()` internally could not be replayed"
   (`feed/connection.ts`, `PublicMarketFeedDependencies`).
6. **Why it needed a ruling.** `WP-300c` closed `WP300C-J1` with a token from a
   required injected source. Its verifiers held that this design needed an ADR
   or a user ruling (G1). Both would accept `1322b89` unchanged once G1 was
   discharged. The design is the draft in `WP-300c`'s round-3 handoff,
   follow_up 1, outside the repository.

## Decision

The user ruled for the token. These statements record the design and the
obligations it creates.

1. **D1. The id format.** A reconciliation request id is
   `compositeKey("wallet-op", operationId, "reconciliation", n, token)`.
   - `compositeKey` (`guards.ts`) length-prefixes each part, so two different
     tuples never give the same id.
   - `n` is the operation's request count, as before.
   - `token` is drawn once per id, when the id is built (`#requestFor`).
   - An id that an answer named before it was issued is skipped (D7). The
     count then advances, and a new token is drawn.
2. **D2. The token source.** `WalletOperationManagerDependencies.requestToken:
   () => string` is required.
   - The constructor reads it once. Anything but a function is refused with a
     `TypeError`.
   - A valid token is a non-empty string of at most
     `MAX_REQUEST_TOKEN_LENGTH` characters, which is 128. This manager must
     never have drawn it before. A UUID is 36 characters.
   - The source must not call back into the manager.
   - `packages/inventory` uses no randomness itself. Given the source, it stays
     deterministic.
3. **D3. The CSPRNG binding.** The composition root binds `requestToken` to a
   CSPRNG, for example `() => crypto.randomUUID()`.
   - A predictable source re-opens `WP300C-J1`: a counter, a clock, or anything
     derived from the operation or readable by the reconciler.
   - The type cannot enforce this. The manager refuses only a missing source,
     and malformed or repeated tokens.
   - The composition round adds a conformance test: composed ids cannot be
     derived from earlier ones.
   - The pin "(control: the token contract)" shows it: with a source the
     reconciler can read ahead, the held read is bound again.
   - Most inventory unit tests use a predictable counter source
     (`RequestTokens`, `test/unit/inventory/helpers.ts`), so a test can name
     an id ahead of time. Production must never use such a source.
4. **D4. `WP-290`'s obligations.** The reconciler (§9.17):
   - echoes `requestId` verbatim. It treats the id as opaque, and never
     derives one;
   - never answers a request with a read made before receiving that request;
   - never relabels a stale read with a newer request's id.

   No id scheme can detect a read made before receipt, because an answer
   carries no read time. The token does not replace these obligations.
5. **D5. A failed draw, and liveness.** A draw fails when the source throws,
   returns a non-string or `""`, returns more than 128 characters, or repeats
   a token.
   - The request is then built without a token. It is never delivered, so no
     answer can be bound to it.
   - It is queued. If it still has to be sent, `retryReconciliationRequests`
     replaces it with a fresh request, under a fresh draw.
   - A source that keeps failing stalls reconciliation, with the reservations
     held. That is safe, but silent.
   - So the composition calls `retryReconciliationRequests` on a cadence, and
     alerts on `outstandingReconciliationRequests()`.
6. **D6. Reproducibility.** Request ids are not reproducible across runs. Under
   a CSPRNG, the same events give different ids.
   - A journal or replay of requests, or of answers that echo their ids,
     records the drawn tokens. Or it injects a replay source that returns the
     recorded tokens in order.
   - A predictable replay source is never the production source. That would
     re-open `WP300C-J1`.
7. **D7. Ids named before receipt stay refused.** An answer is bound only to a
   request that the reconciler had received, for the operation the answer is
   addressed to, before the manager began reading the answer. A request whose
   `request` call is still in progress counts as received: a synchronous
   requester answers inside it.
   - An id that an answer names is recorded (`#namedUnissued`) when, at that
     moment, no request for that operation had been received under it. That
     includes an answer addressed to an operation that does not exist. No
     request is ever issued under such an id. A queued request whose id is
     named before its delivery is never delivered under that id. Retry
     replaces it, if it still has to be sent.
   - An id received only during the read of the answer that names it is
     recorded too (`#namedBeforeReceipt`). No answer is ever bound to it
     afterwards. A later answer naming it is refused, a verbatim replay
     included.
   - Each id is recorded the moment the answer's `requestId` is read, before
     any later field of the answer (`#bindNamedRequest`).
   - The records live as long as the manager, in memory.
8. **D8. The replacement request.** Once an answer has been handled, the
   operation's latest request may be one whose id is in `#namedBeforeReceipt`
   (D7). The manager then replaces that request
   (`#replaceNamedBeforeReceipt`).
   - **When it fires.** Only while the operation still awaits an answer: it is
     RECONCILING, or terminal and quarantined. Never in flight, and never
     terminal without a quarantine. Not when the answer's own weighing already
     raised a newer request.
   - **What it is.** A fresh request, under a new id and token. Its trigger is
     `WALLET_OPERATION_UNKNOWN` for a RECONCILING operation. It is
     `POSITION_BALANCE_DISCREPANCY` for a quarantined one.
   - **How it is sent.** At once, or queued when it cannot be delivered: the
     reconciler refuses it, its token draw fails, or another request's
     delivery is in progress. Delivery is never re-entrant.
     `retryReconciliationRequests` delivers it. After a failed draw, retry
     sends a fresh request in its place.
   - **While the executor call is pending,** the replacement is owed
     (`requestOwed`). It is sent when the executor answers.

   So the reconciler always holds a request it can answer, or is handed one
   by retry.

## Options considered

- **An unguessable token from an injected source:** chosen (D1-D8).
- **No token, resting on `WP-290`'s contract alone:** rejected by the
  user's ruling. It was the "no" answer put to the user. The held-back read
  would rest on one rule: the reconciler never answers with a read made
  before receiving the request. `WP-300c`'s round-1 review offered it as its
  other remedy, with a conformance test in `WP-290`.
  - The orchestrator recommended the token, because it defends the release of
    collateral.
  - Without the token, the manager has no defence of its own. A reconciler
    that broke the contract could release collateral, or make an approval
    ready.
  - `WP-290` is not built yet. Until it is, nothing would test that
    contract.
- **A deterministic id:** cannot close `WP300C-J1` (Context 4).
- **Drawing the token inside `packages/inventory`:** not taken. The package
  uses no randomness (Context 5).

## Consequences

- **`WP300C-J1` is closed in the package.** A held-back read cannot name a
  token it has not seen. So it names an id never issued, and is never bound,
  however long it is held.
- **In a deployed system it is closed only once a composition binds a
  CSPRNG.** No composition root builds a `WalletOperationManager` yet; only
  tests do. Nothing here raises the PAPER ceiling (ADR-010).
- **A relabelled stale read stays undetectable.** D4 makes it `WP-290`'s
  obligation.
- **Ids are not reproducible across runs** (D6). Nothing journals or replays
  these requests today. The manager's request map is in memory only
  (`WP300-PERSIST`).
- **A failing source stalls reconciliation,** safely but silently, until the
  composition adds D5's retry cadence and alert.
- **The in-memory records only grow:** the named ids, the drawn tokens, the
  untokened ids and the receipts. `WP300-PERSIST` owns persisting or bounding
  them.
- **The constructor gained a required dependency.** A construction without a
  source fails at once.
- **The obligations owed.** `IMPLEMENTATION_STATUS.md` tracks them as
  `WP300C-OBLIGATIONS`:
  - the composition round: D3's binding and conformance test; D5's retry
    cadence and alert; D6, for any journal or replay;
  - `WP-290`: D4.
- **Changing it later.** Removing the token, or allowing a predictable
  production source, re-opens `WP300C-J1`. That needs a new ADR.

## Evidence

- The question put to the user: `IMPLEMENTATION_STATUS.md` at `b677fd8`,
  Human items, "The `WP-300c` request-token ruling". The ruling is recorded by
  governance commit `4daa884`.
- `docs/handoffs/WP-300c.md` (governance `315fe80`): summary, Rounds,
  known_risks and follow_up.
- `IMPLEMENTATION_STATUS.md` from `315fe80`: Residual queue,
  `WP300C-OBLIGATIONS` and `WP300-PERSIST`.
- Handoff §9.14, §9.17 and §12.4. ADR-006 §8. ADR-010.
  `docs/contracts/dependency-direction.md`, layer 1.
- Code at `7e05702`:
  - `packages/inventory/src/wallet-operation-manager.ts`: the header's
    "REQUEST IDS"; `MAX_REQUEST_TOKEN_LENGTH`;
    `WalletOperationManagerDependencies.requestToken`;
    `ReconciliationRequest.requestId`; the constructor;
    `resolveByReconciliation`, `#bindNamedRequest` and
    `#replaceNamedBeforeReceipt`; `retryReconciliationRequests` and
    `outstandingReconciliationRequests`; `#requestFor`, `#deliver`,
    `#deliverOrQueue` and `#drawToken`;
  - `packages/inventory/src/guards.ts`: `compositeKey`;
  - `packages/inventory/src/index.ts`: the header;
  - `packages/polymarket-public/src/feed/connection.ts`:
    `PublicMarketFeedDependencies.connectionId`.
- The id format at `28d542a`: the module function `requestFor` in
  `packages/inventory/src/wallet-operation-manager.ts`.
- Tests at `7e05702`:
  - `test/unit/inventory/request-tokens.test.ts`: "WP300C-J1: a read held back
    for the predicted next request is never bound to it", including the pin
    "(control: the token contract)"; "WP300C-J1: the request-token source";
    and the `WP300C-R2-X5` block;
  - `test/unit/inventory/request-ids.test.ts`: the "predictable request ids",
    `WP300C-J2`, `WP300C-R2-X1`, `WP300C-R3-01` and `WP300C-R3-02` blocks.
- The round-1 reproduction of `WP300C-J1` is in `WP-300c`'s review reports,
  outside the repository. The pins above reproduce its sequence.
- No venue fact is used.
