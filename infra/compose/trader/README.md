# Local operation of the PAPER trader

This directory holds the trader's example configuration. The Redis and
PostgreSQL a PAPER run uses come from the PAPER operations stack,
[`../paper/compose.yaml`](../paper/compose.yaml), shared with the data gateway.
**The procedure** (start order, stop, exit codes, halt response, restart after
an outage) is [`docs/runbooks/paper-operations.md`](../../../docs/runbooks/paper-operations.md).

## Safety

- The trader is **PAPER only**. `apps/trader/src/safety.ts` refuses to start
  under a raised `MAX_RUN_MODE`, under a run mode that places real orders or
  needs a live signer, or in an environment that so much as **references** a
  production secret name (§15, ADR-010 §3, venue report §16.1–§16.3).
- **No credential, signer, wallet or API key** appears in
  `trader.config.example.json`, and none is representable in the trader's
  configuration schema. Execution is **simulated**: the only `ExecutionVenue`
  the process can be handed is `packages/simulation`'s, which refuses
  `EXECUTION_PROBE`, `LIVE_MICRO` and `LIVE` by name.
- The four `AGENTS.md` defaults are set **explicitly** in the usage below rather
  than left to a default, so an operator sees the boundary rather than having to
  know it.
- **No public network exposure** (§15): the stack's ports bind to `127.0.0.1`.

## Registering the run first (`REGISTER-1`)

Since `BOOT-1` the trader **refuses to start** unless the `catalog.markets`,
`strategy.instances` and `strategy.runs` rows its configuration names exist in
the database and agree with it (`TRADER_REGISTRATION_MISSING`, exit 78). The
identities in `trader.config.example.json` are placeholders no row carries, so
the example as shipped is refused at that check. The trader app's registration
command creates the rows and writes the document the trader then starts from:

```bash
# 1. A TEMPLATE: the trader document with the five minted identities removed,
#    and the market's real conditionId, token ids and times filled in.
jq 'del(.markets[0].marketId, .instances[0].instanceId, .instances[0].runId,
        .instances[0].configId, .instances[0].marketId)' \
  infra/compose/trader/trader.config.example.json > /path/to/template.json

# 2. Register: PAPER only, with the same four defaults and DATABASE_URL as the trader.
MAX_RUN_MODE=PAPER \
ALLOW_REAL_ORDERS=false \
LIVE_MICRO_MAX_ORDER_NOTIONAL=0 \
LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0 \
DATABASE_URL=postgres://devlocal:devlocal-only-not-a-secret@127.0.0.1:55432/polymarket_bot_paper \
  pnpm --filter @polymarket-bot/trader run register -- \
    --template /path/to/template.json --out /path/to/trader.config.json \
    --instance-name static-bracket-h1 --question-title "<the market's question>" \
    --neg-risk false --trading-delay-seconds 0 --lifecycle-state OPEN \
    --yes-label Up --no-label Down \
    --code-commit "$(git rev-parse HEAD)" --created-by "<you>"

# 3. Start the trader on the COMPLETED document the command wrote.
MAX_RUN_MODE=PAPER \
ALLOW_REAL_ORDERS=false \
LIVE_MICRO_MAX_ORDER_NOTIONAL=0 \
LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0 \
TRADER_CONFIG_PATH=/path/to/trader.config.json \
REDIS_URL=redis://127.0.0.1:56379 \
DATABASE_URL=postgres://devlocal:devlocal-only-not-a-secret@127.0.0.1:55432/polymarket_bot_paper \
  pnpm --filter @polymarket-bot/trader start
```

The venue facts in step 2 (the question, `negRisk`, the order delay, the
outcome labels) are the operator's to read off the market; the values above
are placeholders, and the command defaults none of them. `register --help` is
the full reference (every flag, every exit code). In short:

- **Safety first**: the trader's own PAPER check runs on the environment before
  any file is read or connection attempted; anything else exits 78.
- **Validated before connecting**: the template must pass the trader's
  configuration door and its composition root, in memory (risk policy,
  allocator caps, the strategy's own parameter validator).
- **One transaction**: `registerMarket`, `createDefinition`, `createConfig`,
  `createInstance` and `startRun` (the `WP-040` repositories) either all land
  or none does. The strategy parameters are stored exactly as the document
  states them, with numbers as decimal strings.
- **Running it again is refused** when a condition id, token id or PAPER
  instance name is already registered; nothing is written. The static-bracket
  definition and an identical config are reused.
- **`--out` is never overwritten.** On success, one JSON line with the minted
  ids is printed on stdout.
- **Pass absolute paths.** Under `pnpm --filter @polymarket-bot/trader run
  register` the command runs in `apps/trader`, so a relative `--template` or
  `--out` resolves there, not in the directory pnpm was started in.
- **It does NOT verify a `gammaMarketId`** (`UNIV4-R1`). Verify the data
  gateway's `lifecycle` block by hand against
  `GET https://gamma-api.polymarket.com/markets/{id}` before the run. The
  command prints this reminder.

## The example configuration is an EXAMPLE, and two fields say so

`trader.config.example.json` is a complete, valid document — every field in the
trader's schema is required and none is defaulted — but two values in it must be
read before it is copied, and both are safety-relevant:

| Field | What it says, and why |
| --- | --- |
| `markets[].conditionId` | `REPLACE-WITH-A-REAL-CONDITION-ID`, a placeholder. A market identity is a venue fact; this file invents none. |
| `markets[].settlementReadiness.modelDependentActivationAllowed` | `true`, in this **PAPER** example only (since `TRADER-SIGNALS`, 2026-10-05). See below. |

**`modelDependentActivationAllowed: true` is a PAPER-only operator assertion,
not a settlement review.**

- **What it is.** The repository owner ruled on 2026-10-05 that PAPER
  configurations may set it for `btc-15m-updown`. The ruling is recorded in
  [`docs/settlement/btc-15m-updown-review-checklist.md`](../../../docs/settlement/btc-15m-updown-review-checklist.md).
  With it, a paper run can pass §9.8 check 6 and fill.
- **What it is not.** It is not a recorded settlement review. Nothing in the
  repository can record one yet: see gaps G-1 to G-10 in
  [`docs/settlement/btc-15m-updown-review.md`](../../../docs/settlement/btc-15m-updown-review.md)
  §5.3. The trader reads no review, and the series' spec stays `UNVERIFIED`.
- **A live configuration must not copy it** until a review can be recorded
  for the series and has been. The example's `environment` is `PAPER`, and a
  test (`test/integration/paper-trader/compose-and-example-config.test.ts`)
  fails if the example ever sets the flag `true` in any other environment.
- **What `false` does.** The field echoes the §9.2/§9.3 readiness answer
  that `packages/universe`'s `evaluateMarketReadiness` would produce, if a
  composition root called it. With `false`, §9.8 check 6 refuses every entry
  (`RISK_SETTLEMENT_UNVERIFIED`), so no paper fill is possible. The example
  shipped `false` until 2026-10-05, and H1 runs 2-8 ran with `false`
  ([`docs/handoffs/H1-RUNS-2-8.md`](../../../docs/handoffs/H1-RUNS-2-8.md)).

`simulation.fillModelParametersHash` is likewise all zeros: Tier 0 is the
pipeline-smoke model, whose `deploymentDecisionUse` is `FORBIDDEN` (ADR-012
§1), so there are no calibrated parameters to hash. A Tier-1 run states a real
one.
