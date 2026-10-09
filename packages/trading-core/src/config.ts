/**
 * The trader's configuration door — ADR-020 §5 / `docs/contracts/schema-boundary.md`
 * §6 rule 1.
 *
 * > "A new or substantially rewritten boundary that parses caller- or
 * > wire-supplied values **conforms on arrival**. It costs little at
 * > construction and is expensive later."
 *
 * Operator configuration is caller-supplied by definition, so this door
 * performs all four steps of schema-boundary §1, and the cautionary precedent
 * is named rather than implied: `apps/data-gateway`'s `parseGatewayConfig` is
 * recorded **LIVE ×2** in that document's §3 — "a get-only inherited
 * `tickIntervalMs` defeats its `.default()` and the `dataLossBoundMs` startup
 * check silently passes; an inherited `binance` block satisfies 'at least one
 * feed must be configured'". Both of those are startup checks on an unattended
 * process, which is exactly what this file is.
 *
 * ## Conformance statement (schema-boundary §4)
 *
 * 1. **D1 — materialize prototype-free before parsing.** `readPlainData` from
 *    `@polymarket-bot/risk/plain-data` takes the caller's value apart with
 *    DESCRIPTORS, refuses anything that is not plain own data, and returns a
 *    tree with no prototype. Nothing here reads a property off the caller's
 *    object.
 * 2. **D2 — parse through the severed, warmed arena.** `prototypeFreeParser`
 *    from `@polymarket-bot/risk/schema-arena` builds the parsing copy at module
 *    load, so a lazy is never forced cold and no `_zod` container is reachable
 *    from `Object.prototype`.
 * 3. **D3 — values come from the materialized tree.** The schema ANSWERS
 *    whether the document is valid; the value this module returns is built from
 *    the materialized tree, never from `parsed.data`.
 * 4. **D4 — emit prototype-free.** The returned configuration is assembled onto
 *    `Object.create(null)` containers and deep-frozen.
 * 5. **The bound.** Under inherited-property interference, permission never
 *    varies: a document that is refused clean is refused polluted, and a
 *    document that parses clean parses to the same values polluted. The
 *    regression battery is `apps/trader/src/config.test.ts`.
 *
 * Why the canonical door and not a local copy: `docs/contracts/dependency-direction.md`
 * §2 puts `apps/trader` in **layer 3** and `packages/risk` in layer 1, so the
 * edge is DOWNWARD and permitted outright — a §2.1 same-layer row is neither
 * needed nor available for it. `packages/risk` exports `./plain-data` and
 * `./schema-arena` through its `exports` map, so the import is an entry-point
 * import and not a deep one (F16). And `WP-180-FU2`'s repo-wide deletion guard
 * (`test/unit/execution-planner/mirrors.test.ts`) explicitly walks `apps/*` —
 * "a verbatim `cp` of the door into `apps/trader/src/pasted-door.ts` passed this
 * file 7/7" is the finding that put it there — so pasting a copy is a contract
 * violation, not a shortcut.
 *
 * ## No bare `.default()` on a safety-relevant setting
 *
 * Every field below is REQUIRED. The two reasons, in order of weight:
 *
 * - a `.default()` is exactly the class schema-boundary §2 records as "Defaults
 *   defeated": a get-only inherited accessor on a defaulted key makes the parse
 *   succeed while the default never lands as an own property, so any check
 *   gated on it silently skips. `apps/data-gateway`'s row is that defect,
 *   measured;
 * - a defaulted safety bound is a bound nobody chose. `packages/strategies/static-bracket`
 *   states the same rule for the same reason, and this file follows it.
 *
 * The run-mode ceiling is NOT a field here at all: it is `safety.ts`'s, it is
 * read from the environment before this module runs, and a configuration
 * document cannot raise it.
 */

import { z } from "zod";

import { explainCanonicalDecimalString } from "@polymarket-bot/decimal";
import { Uuidv7Schema } from "@polymarket-bot/domain";
import { readPlainData } from "@polymarket-bot/risk/plain-data";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";
import { ReviewedSeriesSchema, seriesConfigHash, type ReviewedSeries } from "@polymarket-bot/universe";

import {
  BOOK_FRESHNESS_BASES,
  DEFAULT_BOOK_FRESHNESS_BASIS,
  type BookFreshnessBasis,
} from "./book-freshness.js";

/** A positive integer bound in milliseconds, small enough to be a real bound. */
const BoundedMs = z.number().int().positive().max(86_400_000);
const BoundedDepth = z.number().int().positive().max(1_000_000);

/**
 * An economic field, checked by the DOMAIN's own canonical-decimal validator.
 *
 * ## Why not a regex (review round 2, MEDIUM-2 — MEASURED)
 *
 * Both decimal fields here used to be hand-written regexes, and both were
 * WIDER than the canonical form `@polymarket-bot/decimal` defines: canonical
 * form has no leading zeros, no trailing fractional zeros and no `-0`, and
 * `/^(?:0|[1-9]\d*)(?:\.\d+)?$/` admits `"1000.00"`, `"0.0"` and (in the signed
 * variant) `"-0"`. The consequence was measured end to end at the r1 tip:
 *
 * ```text
 * parseTraderConfig({ …startingCash: "1000.00" })  -> ok: true
 * loop.drain()  -> UNCAUGHT InvalidDecimalStringError:
 *                  subDecimal(a): "1000.00" is not a canonical decimal string
 * ```
 *
 * A door whose grammar is broader than the arithmetic behind it does not fail
 * closed — it defers, and the deferral surfaces as a throw out of the event loop
 * on the first fill, with no refusal naming the field. (It is fail-STOP, not a
 * wrong number: `@polymarket-bot/decimal` refuses rather than coercing, which is
 * why this is a MEDIUM and not a HIGH.) Delegating to
 * {@link explainCanonicalDecimalString} makes the door and the arithmetic the
 * SAME authority, exactly as `packages/domain`'s `decimalStringSchema` and
 * `packages/execution-planner`'s `validate.ts` already do.
 *
 * Layer note: `@polymarket-bot/decimal` is layer 0 and `apps/trader` is layer 3
 * (`docs/contracts/dependency-direction.md` §2), so the edge is downward and
 * permitted; the package is already a declared dependency of this app.
 */
function canonicalDecimalSchema(range?: "NON_NEGATIVE"): z.ZodType<string, string> {
  return z.string().superRefine((value, ctx) => {
    const problem = explainCanonicalDecimalString(
      value,
      range === undefined ? undefined : { range },
    );
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });
}

/** A canonical decimal of either sign (§6 invariant 1; no exponent, no `+`). */
const CanonicalDecimal = canonicalDecimalSchema();
/** A canonical decimal that is `>= 0`. */
const NonNegativeDecimal = canonicalDecimalSchema("NON_NEGATIVE");
const Identifier = z.string().min(1).max(200);
/**
 * The `packages/domain` `CodeString` grammar, restated here as a REFUSAL at the
 * trader's own door.
 *
 * `packages/risk`'s evaluation input types every `ScopeAttribution` key as
 * `CodeString` — "must be an alphanumeric code without whitespace", and the
 * pattern requires a LETTER first (`^[A-Za-z][A-Za-z0-9_.:-]*$`). A
 * configuration that violates it produces a `RISK_INPUT_INVALID` refusal on the
 * first intent, mid-run, with no order placed and nothing to point the operator
 * at. Refusing it HERE turns that into a startup failure naming the field.
 *
 * SCOPE KEYS ONLY. `context.strategyInstanceId` was typed this way too until
 * ADR-021 ruled it an identity and `WP-180-FU3` re-typed it; see
 * {@link Uuidv7}. A scope key really is what `CodeString` documents itself for
 * — "a stable machine vocabulary token: reason codes, tags, feed identifiers,
 * channel names" — which is why this grammar stays for these fields and only
 * for them.
 */
const CodeString = z.string().min(1).max(200).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u, {
  message:
    "must be a §7 CodeString: a LETTER followed by alphanumerics, '_', '.', ':' or '-' " +
    "(packages/risk types the scope keys this way)",
});
const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, {
    message: "must be a canonical LOWERCASE UUID (ADR-016 §2: refused, never case-folded)",
  });

/**
 * `packages/domain`'s OWN `Uuidv7Schema` — the identity grammar, not a copy.
 *
 * ADR-021 (accepted 2026-09-06, amended the same day) ruled `strategyInstanceId`
 * an identity rather than a code token, and every door that constrains it now
 * says so: `packages/risk` (`WP-180-FU3`, `8c14b47`) and
 * `packages/capital-allocator` (`ALLOC-1`, `d9f70a6`) were re-typed to
 * `Uuidv7Schema`, which `packages/ledger`'s `AllocationClaim.instanceId` and
 * `packages/pnl`'s `PnlOwner.instanceId` always were. Four merged doors, one
 * grammar — so `WP-230`'s interim intersection (`UuidAndCodeString`: a UUID
 * shape whose first hex digit had to be a LETTER, shipped while the doors
 * disagreed) is deleted rather than kept as a local narrowing.
 *
 * Deleting it is NOT a pure relaxation, and that is the point. The interim
 * regex was version- and variant-BLIND: a lowercase **v4** with a letter lead
 * passed THIS door at startup and was refused only mid-run by the risk door.
 * The domain schema admits the `0`-leading population every real mint produces
 * AND enforces the version and variant nibbles, so the admitted and refused
 * populations move in opposite directions. Both directions are pinned in
 * `config.test.ts`.
 *
 * Imported rather than restated for the reason {@link canonicalDecimalSchema}
 * gives: a second copy of a grammar here can drift from the doors this value
 * must actually pass, and then the startup answer and the runtime answer differ.
 */
const Uuidv7 = Uuidv7Schema;

/** §8.3 bounds. Every queue in this process is sized here, explicitly. */
const QueueBoundsSchema = z.strictObject({
  /** The ingest queue: normalized events waiting for the core loop. */
  ingestMaximumDepth: BoundedDepth,
  /** The decision outbox: records waiting to reach the durable store. */
  outboxMaximumDepth: BoundedDepth,
});

/** The feature-engine configuration (`packages/features` `ValidatedConfig`). */
const FeatureConfigSchema = z.strictObject({
  depthLevels: z.array(z.number().int().positive().max(100)).min(1).max(32).readonly(),
  /** The quantities the executable-price features are computed for. */
  executableShares: z.array(NonNegativeDecimal).min(1).max(32).readonly(),
  tradeWindowMs: BoundedMs,
  ewmaLambda: NonNegativeDecimal,
  primaryReferenceVenue: z.enum(["binance", "coinbase"]),
});

/**
 * `THROUGHPUT-1c` (ADR-023 D4) — how a venue book's age is measured, for the
 * feature engine's `polymarket.book` input, the strategy's data-quality gate
 * (through the projected `quality.input_feed_ages@polymarket.book`) and §9.8
 * check 7's `VENUE_BOOK` measurement.
 *
 * - `LAST_CHANGE`: the instant of the book's last applied update — the rule
 *   every run before ADR-023 used.
 * - `CONNECTION_CONFIRMED`: the later of that and the latest market-channel
 *   event consumed on the SAME delivery session (`book-freshness.ts`), with
 *   every fallback to `LAST_CHANGE` that module lists — including the
 *   REQUIRED per-book ceiling `maximumLastChangeAgeMs` (rule 6).
 *
 * ## Why this block may be ABSENT (the one optional key of this document)
 *
 * The header's rule is that no safety-relevant field is defaulted, because "a
 * defaulted safety bound is a bound nobody chose" and a defeated `.default()`
 * silently skips a check. Neither reason reaches this block:
 *
 * - absence selects `LAST_CHANGE`, and `CONNECTION_CONFIRMED` is never stricter
 *   than it (the confirmed instant is never before the last change), so an
 *   absent block is the STRICTEST choice, not someone else's looser one;
 * - there is no `.default()`: absence is read as an own-property absence on the
 *   D1-materialized, prototype-free tree ({@link bookFreshnessBasisOf}), so an
 *   inherited `bookFreshness` cannot be adopted.
 *
 * And it must be absent-tolerant: every configuration written before ADR-023 —
 * the registered runs `BOOT-1` compares, the recorded golden configurations,
 * an operator's H1 template — has no such block and must still load with its
 * original meaning.
 */
/**
 * The per-book ceiling on the book's OWN last-change age under
 * `CONNECTION_CONFIRMED` (ADR-023 D2 rule 6; review round 1, finding X1).
 * Session traffic proves the session delivers, never that THIS asset's changes
 * are delivered, so the extension stops vouching for a book once its own last
 * change is older than this. REQUIRED with that basis (no default: a safety
 * bound nobody chose is not a bound), and capped at ten minutes so the
 * extension cannot be configured into a disguised "freshness off".
 */
export const MAXIMUM_LAST_CHANGE_AGE_CAP_MS = 600_000;
const LastChangeCeilingMs = z.number().int().positive().max(MAXIMUM_LAST_CHANGE_AGE_CAP_MS);

/**
 * `C1-HALTS` (TAINT; the user's ruling of 2026-10-08, ADR-023's dated note):
 * the gateway `feedId` of the Polymarket MARKET CHANNEL, whose market-less
 * incidents taint a gateway epoch (rule 4). Optional, and absence means
 * {@link DEFAULT_MARKET_CHANNEL_FEED_ID} — the id both example configurations
 * use, pinned equal by a repository test — so no operator must set a new knob
 * to keep the protection. A WRONG value is the unsafe direction (the market
 * channel's own incidents would stop tainting), which is why it defaults
 * rather than being required, and why the trader logs it at start.
 */
export const DEFAULT_MARKET_CHANNEL_FEED_ID = "polymarket-market";

const BookFreshnessConfigSchema = z.discriminatedUnion("basis", [
  z.strictObject({ basis: z.literal(BOOK_FRESHNESS_BASES[0]) }),
  z.strictObject({
    basis: z.literal(BOOK_FRESHNESS_BASES[1]),
    maximumLastChangeAgeMs: LastChangeCeilingMs,
    marketChannelFeedId: CodeString.optional(),
  }),
]);

/** One market this process trades, with the versioned parameters §6 invariant 9 pins. */
const MarketConfigSchema = z.strictObject({
  marketId: Uuid,
  conditionId: Identifier,
  yesTokenId: z.string().regex(/^(?:0|[1-9]\d*)$/u),
  noTokenId: z.string().regex(/^(?:0|[1-9]\d*)$/u),
  tickSize: NonNegativeDecimal,
  minimumOrderSize: NonNegativeDecimal,
  makerFeeRate: NonNegativeDecimal,
  takerFeeRate: NonNegativeDecimal,
  /** Strict-UTC; `time.ts` normalises and refuses an offset form. */
  openTime: z.string().min(1),
  closeTime: z.string().min(1),
  /**
   * §6 invariant 9: the version of the trading-parameter set the prices, tick
   * and minimum size above belong to.
   *
   * REQUIRED and operator-stated, because §9.8 check 9 ("current trading
   * parameters are known") fails closed on its absence — and correctly: a run
   * whose parameters carry no version cannot claim that "historical runs use
   * historical parameters".
   */
  parametersVersion: z.number().int().min(0).max(1_000_000_000),
  /**
   * The structural echo of the §9.2 / §9.3 readiness answer that
   * `packages/universe`'s `evaluateMarketReadiness` produces.
   *
   * REQUIRED, with NO default, and that is the whole point: §9.8 check 6 and
   * the policy's `requireVerifiedSettlementForEntries` refuse an entry into a
   * market whose settlement specification is not verified, and a default of
   * `true` here would silently satisfy a gate that exists to stop exactly that.
   *
   * **The authoritative source is not this field.** `packages/universe` and
   * `packages/settlement` own the answer; wiring them into this process is a
   * recorded follow-up (`README.md`). Until that lands, an operator states the
   * reviewed answer explicitly and is accountable for it — which is strictly
   * better than a composition root that asserts readiness on its own.
   *
   * The `btc-15m-updown` caveat applies and is not weakened here: that series
   * has NO human-reviewed settlement specification in this repository
   * (`packages/strategies/static-bracket/README.md`), so a truthful
   * configuration for it states `false` and its entries are refused.
   */
  settlementReadiness: z.strictObject({
    modelDependentActivationAllowed: z.boolean(),
  }),
  /** §9.2 scope attribution for the §9.7 exposure dimensions. `CodeString`. */
  seriesKey: CodeString,
  underlyingKey: CodeString,
  resolutionWindowKey: CodeString,
});

/**
 * One strategy instance.
 *
 * `evaluationPriority` and `ownership` are §8.2's stable order: "market
 * ownership priority, strategy instance priority, strategy instance UUID". Both
 * are REQUIRED, because an implicit priority is an implicit evaluation order
 * and §8.2 requires the order to be "stable and recorded in the run manifest".
 */
const InstanceConfigSchema = z.strictObject({
  /**
   * The instance's IDENTITY: a canonical lowercase UUIDv7 ({@link Uuidv7}).
   *
   * Every door this value must pass types it that way — `packages/risk`'s
   * `context.strategyInstanceId`, `packages/capital-allocator`'s reservation
   * and state surfaces, `packages/ledger`'s `AllocationClaim.instanceId` and
   * `packages/pnl`'s `PnlOwner.instanceId` — so the check here is the same
   * check, made at startup, on the field an operator can point at. A letter-
   * leading UUIDv7 (what `WP-230`'s interim grammar minted) is still valid; a
   * wrong-version or wrong-variant UUID no longer is.
   */
  instanceId: Uuidv7,
  runId: Uuid,
  configId: Uuid,
  /** Canonical unsigned integer string (§10.3 `runs.run_seed`). */
  runSeed: z.string().regex(/^(?:0|[1-9]\d*)$/u),
  marketId: Uuid,
  /**
   * §6 invariant 11: exactly one `OWNER` per market in v1.
   *
   * `OWNER` trades. `SHADOW` is **observe-only in this process**: the instance
   * is evaluated in its §8.2 position and its `DecisionResult`s are persisted,
   * and none of its intents is allocated, planned or submitted (ADR-011 §5 —
   * shadow instances "evaluate, produce decisions, and write records; they do
   * not consume venue rate limits, because they submit nothing").
   *
   * It is stated here because it is the operator's expectation that is at
   * stake: ADR-011 §1 also describes `SHADOW` as "simulated execution,
   * independent accounting", and this process has no second book to keep that
   * accounting in — one cash balance, one ledger, one simulated venue, shared.
   * A shadow instance whose orders executed on the shared book would be a live
   * instance with a shadow label, which is exactly the defect review round 2
   * found. Independent shadow execution is a design, not a setting; until it
   * exists, `SHADOW` here means observe.
   */
  ownership: z.enum(["OWNER", "SHADOW"]),
  evaluationPriority: z.number().int().min(0).max(1_000_000),
  /** §9.6's evaluation-time watchdog. */
  evaluationBudgetUs: z.number().int().positive().max(60_000_000),
  /** The strategy's own §13.2 configuration, validated by the strategy itself. */
  params: z.unknown(),
});

/**
 * `ROLLOVER-1` (ADR-030 Decision 4): a strategy instance bound to a REVIEWED
 * SERIES instead of one market. Each window the series admits gets this
 * instance's own runtime — fresh per-window strategy state — and every one of
 * them belongs to the instance's ONE run (`runId`), numbered by the run's
 * shared evaluation sequence (`@polymarket-bot/strategy-runtime`
 * `RunEvaluationSequence`; the user's ruling Q2). Every field but `seriesId`
 * means what it means on {@link InstanceConfigSchema}.
 *
 * The run record pins the series (ruling Q4): the instance's registered
 * `strategy.configs.parameters` is `{ strategy: <params>, series: <the reviewed
 * series document> }` (`apps/trader` REGISTER-1 and BOOT-1).
 */
const SeriesInstanceConfigSchema = z.strictObject({
  instanceId: Uuidv7,
  runId: Uuid,
  configId: Uuid,
  runSeed: z.string().regex(/^(?:0|[1-9]\d*)$/u),
  /** The `seriesId` of one of this document's `series` entries. */
  seriesId: CodeString,
  ownership: z.enum(["OWNER", "SHADOW"]),
  evaluationPriority: z.number().int().min(0).max(1_000_000),
  evaluationBudgetUs: z.number().int().positive().max(60_000_000),
  params: z.unknown(),
});

/** §9.15 / ADR-006 account and asset identity. No implicit "cash" asset exists. */
const AccountingConfigSchema = z.strictObject({
  accountRef: Identifier,
  denominationAssetId: Identifier,
  venueClearingRef: Identifier,
  attributionClearingRef: Identifier,
  feeExpenseRef: Identifier,
  startingCash: NonNegativeDecimal,
});

/** §9.10 planning policy. Every knob explicit; none defaulted. */
const PlanningConfigSchema = z.strictObject({
  maxSliceShares: NonNegativeDecimal,
  marketableSlippageTicks: z.number().int().min(0).max(1000),
  replaceThresholdTicks: z.number().int().min(0).max(1000),
  minimumReplaceIntervalMs: z.number().int().min(0).max(86_400_000),
  cancelDeadlineMs: BoundedMs,
  maxPlanLifetimeMs: BoundedMs,
  // §6 invariant 6's silence bound — how long an unconfirmed cancel may stay
  // unresolved before the root closes it `SILENCE_EXCEEDED` — is DELIBERATELY
  // NOT HERE (review round 1, L4). It is a §13.2 STRATEGY parameter
  // (`entry.execution.submission_unknown_after_ms`), validated by the
  // strategy's own validator and read per instance by `loop.ts`'s cancel
  // sweep, so a process-level copy would be a second authority over the same
  // bound. At the reviewed tip this schema REQUIRED such a copy and nothing
  // read it: a required field an operator sets with no effect is worse than an
  // absent one, because it reads as a control.
});

/**
 * The §9.8 check-19 request budget.
 *
 * §9.13's venue rate-limit budget is `WP-310`'s package and does not exist yet;
 * `packages/simulation`'s venue states `rateLimitModel: "NOT_MODELED"` for the
 * same reason. What this process CAN measure honestly is its OWN submission
 * rate against a capacity the operator states — §9.13 forbids hardcoding the
 * venue's published buckets, and this field does not: the number comes from the
 * configuration, and the count comes from this process's own submissions.
 *
 * Disclosed in `README.md` as an interim measure, replaced when `WP-310` ships.
 */
const RequestBudgetSchema = z.strictObject({
  /** Requests the operator states this process may make per window. */
  capacity: z.number().int().positive().max(1_000_000),
  windowMs: BoundedMs,
});

/**
 * One §9.8 check-17 shock scenario.
 *
 * The SHOCK is operator-stated; the MARK is measured. `yesPriceShock` is a
 * signed exact decimal added to the market's current YES mark, and the trader
 * clamps the result into `[0, 1]` — so the scenario a run evaluates is a
 * function of the book it actually saw, not of a number written months ago.
 */
const ScenarioConfigSchema = z.strictObject({
  scenarioId: CodeString,
  kind: z.enum(["SPOT", "VOLATILITY", "TIME", "LIQUIDITY"]),
  yesPriceShock: CanonicalDecimal,
});

/**
 * The §12.5 run pins the simulated venue is constructed from.
 *
 * > "Every replay run pins: … normalizer version, feature-set version, … run
 * > seed, **fill-model version and parameters**, latency-model version and
 * > parameters, **fee/reward snapshot versions**, settlement-spec versions."
 *   — handoff §12.5
 *
 * REQUIRED, every field, with NO default. A run whose fill model was chosen by
 * a default is a run nobody can reproduce or compare, which defeats §12.4
 * before the first event arrives — and ADR-012's evidence hierarchy rests on
 * knowing exactly which model produced a number.
 *
 * The FEE SNAPSHOT is operator-stated for the same §6 invariant 9 reason the
 * market parameters are: "historical runs use historical parameters", and a
 * process that read today's fee schedule into a replay of last week would be
 * reporting a counterfactual.
 */
const SimulationConfigSchema = z.strictObject({
  /** §12.5's fill-model version pin. Carried on EVERY simulated fill. */
  fillModelVersion: CodeString,
  /** Content identity of §12.5's fill-model parameters. */
  fillModelParametersHash: z.string().regex(/^[0-9a-f]{64}$/u, {
    message: "must be 64 lowercase hexadecimal characters",
  }),
  /** §6 invariant 9 / §12.5: the fee schedule this run books against. */
  feeSchedule: z.strictObject({
    snapshotVersion: CodeString,
    takerFeeRate: NonNegativeDecimal,
    makerFeeRate: NonNegativeDecimal,
    roundingDecimalPlaces: z.number().int().min(0).max(18),
    roundingMode: z.enum(["HALF_UP", "HALF_EVEN", "UP", "DOWN"]),
    minimumChargedFee: NonNegativeDecimal,
    feeCurrency: CodeString,
  }),
}, {
  // `C1-TIDY`: `simulation.startingCash` is gone (the venue opens with
  // `accounting.startingCash`). An old document is refused, saying where it went.
  error: (issue) =>
    issue.code === "unrecognized_keys" && issue.keys.includes("startingCash")
      ? "simulation.startingCash was removed: the simulated venue opens with accounting.startingCash; delete this key"
      : undefined,
});

/** The infrastructure endpoints. Names only — no credential is representable. */
const InfrastructureConfigSchema = z.strictObject({
  /** Redis stream the gateway publishes normalized events to (ADR-003). */
  eventStream: Identifier,
  consumerId: Identifier,
  /** Maximum events per `poll`. Bounded (§8.3). */
  receiveBatchSize: z.number().int().positive().max(10_000),
  // NO retention bound (C1-RISK, OPS-07, 2026-10-08). §9.1's bounded retention
  // (ADR-003: "a safety parameter, not a tuning knob") is the PUBLISHER's: the
  // data gateway trims the stream (`GATEWAY_RETENTION_EVENTS`). This process
  // only consumes, so a bound stated here was applied to nothing, and it was
  // reported as the stream's retention when it could differ from the
  // gateway's. The strict schema refuses a document that still states one.
});

export const TraderConfigSchema = z.strictObject({
  /** The environment every ledger transaction and PnL stream is stamped with. */
  environment: z.literal("PAPER"),
  /**
   * The §9.8 policy, validated by `packages/risk`'s OWN door.
   *
   * Deliberately `unknown` here. Restating `RiskPolicySchema` in this file would
   * create a second authority on the safety policy that can drift from the
   * first, and it would bypass `parseRiskPolicy` — which is a D1-D4 door whose
   * `.default()` values come from a bound TABLE precisely because a defeated
   * default silently disabled §9.8 checks 2, 6 and 12 in that package's own
   * review round 6. The trader hands the document to `parseRiskPolicy` at
   * startup and refuses to start on a refusal.
   */
  riskPolicy: z.unknown(),
  /** The §9.7 caps, validated by `packages/capital-allocator`'s own door. */
  allocatorCaps: z.unknown(),
  accounting: AccountingConfigSchema,
  queues: QueueBoundsSchema,
  features: FeatureConfigSchema,
  planning: PlanningConfigSchema,
  simulation: SimulationConfigSchema,
  requestBudget: RequestBudgetSchema,
  /**
   * The shock scenarios §9.8 check 17 evaluates.
   *
   * REQUIRED and non-empty: `assessScenarios` reports a required kind that was
   * not supplied as MISSING and the engine refuses the entry — "an unmeasured
   * scenario is not a passed scenario (fail closed)". A configuration that
   * omits a kind the policy requires therefore refuses every entry, loudly.
   */
  scenarios: z.array(ScenarioConfigSchema).min(1).max(64).readonly(),
  /** ADR-023: optional; absent means `LAST_CHANGE` (see the schema's comment). */
  bookFreshness: BookFreshnessConfigSchema.optional(),
  infrastructure: InfrastructureConfigSchema,
  /**
   * The configured markets. EMPTY is allowed only when every instance is
   * series-bound (`ROLLOVER-1`): a run whose markets all come from series
   * admission configures none ({@link crossFieldRefusal}).
   */
  markets: z.array(MarketConfigSchema).min(0).max(1000).readonly(),
  /** Market-bound instances. Empty only when there is a series-bound one. */
  instances: z.array(InstanceConfigSchema).min(0).max(1000).readonly(),
  /**
   * `ROLLOVER-1` (ADR-030 Decision 1.1): the REVIEWED series this trader admits
   * windows of — each the same document the gateway's `seriesAdmission` block
   * names, so the two agree on its configuration hash. Optional: a trader
   * without it ADMITS no window — it attaches none, writes no catalog row and
   * tears nothing down. It still CONSUMES `MarketDiscovered@1` and
   * `SeriesWindowAdmitted@1` (`event-door.ts`), as every trader does, so each
   * such event a gateway publishes is, like any consumed event that names no
   * configured market, a possible source of a `CADENCE-1` carried or
   * heartbeat pass (`ROLLOVER-1` r1, R1-FABLE-08: it does not run "exactly as
   * before" a gateway that admits windows).
   */
  series: z.array(ReviewedSeriesSchema).min(1).max(8).readonly().optional(),
  /** `ROLLOVER-1`: the instances bound to a series rather than a market. */
  seriesInstances: z.array(SeriesInstanceConfigSchema).min(1).max(64).readonly().optional(),
});

export type TraderConfig = Readonly<z.infer<typeof TraderConfigSchema>>;
export type MarketConfig = TraderConfig["markets"][number];
export type InstanceConfig = TraderConfig["instances"][number];
export type SeriesInstanceConfig = NonNullable<TraderConfig["seriesInstances"]>[number];

/** **D2** — the parsing copy, built and WARMED at module load. */
const TraderConfigDoor = prototypeFreeParser(TraderConfigSchema);

export interface ConfigRefusal {
  readonly code:
    | "TRADER_CONFIG_NOT_DATA"
    | "TRADER_CONFIG_INVALID"
    /**
     * Two fields of this document describe ONE quantity and disagree.
     *
     * Its own code because it is not a grammar failure: both values are valid
     * decimals and the document is well formed. See
     * {@link crossFieldRefusal}.
     */
    | "TRADER_CONFIG_INCONSISTENT";
  readonly detail: string;
  readonly issues: readonly string[];
}

export type ParseConfigResult =
  | { readonly ok: true; readonly config: TraderConfig }
  | { readonly ok: false; readonly refusal: ConfigRefusal };

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Parses an operator configuration document. TOTAL: never throws.
 *
 * The order is the point (D1 before D2): the value is materialized FIRST, so
 * the tree the schema inspects and the tree the caller receives are the same
 * tree, and no second read of the caller's object can disagree with the first.
 *
 * ## Why the containment guard is not decoration (MEASURED, 2026-09-05)
 *
 * The warmed arena protects the PARSE. It does not protect the library's own
 * ERROR CONSTRUCTION, and that is a different code path with a different
 * exposure. Measured against the pinned `zod@4.4.3`, with one NON-ENUMERABLE
 * inherited `Object.prototype.get`:
 *
 * ```text
 * arena.safeParse(VALID)    -> ok
 * arena.safeParse(INVALID)  -> TypeError: Invalid property descriptor.
 *                              Cannot both specify accessors and a value or
 *                              writable attribute
 * ```
 *
 * That is `docs/contracts/schema-boundary.md` §2's "Descriptor literals" class
 * arriving on the REFUSAL path — so a door with no guard turns "this
 * configuration is invalid" into an escaped `TypeError`, on exactly the input
 * it exists to refuse. `packages/risk`'s own doors wrap their bodies in
 * `contained(...)` for the same reason; this one does the same with its own
 * guard, so a refusal stays a refusal.
 */
export function parseTraderConfig(input: unknown): ParseConfigResult {
  try {
    return parseTraderConfigInner(input);
  } catch (cause) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_CONFIG_NOT_DATA",
        detail:
          "reading the trader configuration failed unexpectedly and was contained (fail " +
          "closed); a configuration that cannot be evaluated is not a valid configuration",
        issues: [cause instanceof Error ? cause.message : String(cause)],
      },
    };
  }
}

function parseTraderConfigInner(input: unknown): ParseConfigResult {
  // D1.
  const read = readPlainData(input, "config");
  if (!read.ok) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_CONFIG_NOT_DATA",
        detail:
          "the trader configuration is not a data record: a configuration is a finite tree of " +
          "plain own data, so hidden, inherited, computed or unreadable state is refused " +
          "rather than inspected (fail closed)",
        issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`),
      },
    };
  }
  const materialized = read.value;

  // D2 — the arena copy answers; its output is discarded.
  const parsed = TraderConfigDoor.safeParse(materialized);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: {
        code: "TRADER_CONFIG_INVALID",
        detail: "the trader configuration failed validation (fail closed)",
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      },
    };
  }

  // D3/D4 — the value is the materialized tree, frozen. `readPlainData` already
  // built it prototype-free; freezing makes the answer immutable as well.
  const config = deepFreeze(materialized) as TraderConfig;

  const inconsistent = crossFieldRefusal(config);
  if (inconsistent !== undefined) return { ok: false, refusal: inconsistent };

  return { ok: true, config };
}

/** Cross-field consistency, checked after the grammar. */
function crossFieldRefusal(config: TraderConfig): ConfigRefusal | undefined {
  return seriesRefusal(config);
}

/**
 * `THROUGHPUT-1c` (ADR-023): the configured book-freshness basis, read as an
 * OWN property of the parsed (prototype-free, frozen) configuration. Absent
 * means {@link DEFAULT_BOOK_FRESHNESS_BASIS}, the pre-ADR-023 rule.
 */
export function bookFreshnessBasisOf(config: TraderConfig): BookFreshnessBasis {
  if (!Object.hasOwn(config, "bookFreshness")) return DEFAULT_BOOK_FRESHNESS_BASIS;
  const block = config.bookFreshness;
  if (block === undefined || !Object.hasOwn(block, "basis")) return DEFAULT_BOOK_FRESHNESS_BASIS;
  return block.basis;
}

/**
 * `THROUGHPUT-1c` r1 (ADR-023 D2 rule 6): the configured per-book ceiling on
 * the last-change age, read as an OWN property; `undefined` unless the basis
 * is `CONNECTION_CONFIRMED` (whose schema requires it).
 */
export function bookFreshnessCeilingMsOf(config: TraderConfig): number | undefined {
  if (!Object.hasOwn(config, "bookFreshness")) return undefined;
  const block = config.bookFreshness;
  if (block === undefined || block.basis !== "CONNECTION_CONFIRMED") return undefined;
  if (!Object.hasOwn(block, "maximumLastChangeAgeMs")) return undefined;
  return block.maximumLastChangeAgeMs;
}

/**
 * `C1-HALTS` (TAINT): the market-channel feed id rule 4 reads, as an OWN
 * property; {@link DEFAULT_MARKET_CHANNEL_FEED_ID} when absent (and under
 * `LAST_CHANGE`, which reads no taint).
 */
export function marketChannelFeedIdOf(config: TraderConfig): string {
  if (!Object.hasOwn(config, "bookFreshness")) return DEFAULT_MARKET_CHANNEL_FEED_ID;
  const block = config.bookFreshness;
  if (block === undefined || block.basis !== "CONNECTION_CONFIRMED") return DEFAULT_MARKET_CHANNEL_FEED_ID;
  if (!Object.hasOwn(block, "marketChannelFeedId") || block.marketChannelFeedId === undefined) {
    return DEFAULT_MARKET_CHANNEL_FEED_ID;
  }
  return block.marketChannelFeedId;
}

/**
 * Every feature key the loaded instances configure, de-duplicated and sorted.
 *
 * The projection (`projection.ts`) is driven by this set, so a strategy sees
 * exactly the keys its own configuration names and nothing else. Sorted so the
 * projected view's key order — and therefore the runtime's materialized copy of
 * it — is identical across runs (§12.4).
 */
export function configuredFeatureKeys(config: TraderConfig): readonly string[] {
  const keys = new Set<string>();
  // `ROLLOVER-1`: a series-bound instance's params configure feature keys too.
  for (const instance of [...config.instances, ...(config.seriesInstances ?? [])]) {
    const params = instance.params;
    if (typeof params !== "object" || params === null) continue;
    collectFeatureKeys(params as Record<string, unknown>, keys);
  }
  return Object.freeze([...keys].sort());
}

/**
 * Walks a strategy's own params for the keys it will read.
 *
 * The three names come from `packages/strategies/static-bracket`'s obligation
 * 2 — `entry.trigger_feature_key`, `exit.stop.trigger_feature_key` and
 * `data_quality.incident_feature_key`. The walk is by NAME SUFFIX rather than
 * by path, so a strategy that nests them differently is still covered, and it
 * reads own properties only.
 */
function collectFeatureKeys(node: Record<string, unknown>, into: Set<string>): void {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (typeof value === "string" && key.endsWith("_feature_key")) {
      into.add(value);
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      collectFeatureKeys(value as Record<string, unknown>, into);
    }
  }
}

/**
 * `ROLLOVER-1`: the cross-field rules of the series fields, each a document no
 * operator can act on:
 *
 * - at least one instance, market-bound or series-bound;
 * - a market-bound instance needs a configured market (`createPaperTrader`
 *   names the missing one), and a configured market with no instance at all is
 *   still accepted as before;
 * - every series id once; every series has at least one series-bound instance
 *   (a reviewed series nothing trades would admit windows for no run), at most
 *   one OWNER (one live owner per window: §6 invariant 11), and every
 *   series-bound instance names a configured series;
 * - no `instanceId` and no `runId` twice across BOTH instance lists: a run's
 *   evaluation sequence is shared by its runtimes (ruling Q2), so two
 *   instances on one run would interleave one counter, and one instance id on
 *   two lists would be one deployment run twice.
 */
function seriesRefusal(config: TraderConfig): ConfigRefusal | undefined {
  const issues: string[] = [];
  const seriesInstances = config.seriesInstances ?? [];
  const series = config.series ?? [];
  if (config.instances.length === 0 && seriesInstances.length === 0) {
    issues.push("instances, seriesInstances: at least one instance is required");
  }
  if (config.instances.length > 0 && config.markets.length === 0) {
    issues.push("markets: a market-bound instance needs at least one configured market");
  }
  const seriesIds = series.map((entry) => entry.seriesId);
  if (new Set(seriesIds).size !== seriesIds.length) issues.push("series: each seriesId may appear once");
  for (const entry of series) {
    if (!seriesInstances.some((instance) => instance.seriesId === entry.seriesId)) {
      issues.push(`series: ${entry.seriesId} has no series-bound instance; a reviewed series nothing trades admits windows for no run`);
    }
  }
  for (const entry of series) {
    const owners = seriesInstances.filter((instance) => instance.seriesId === entry.seriesId && instance.ownership === "OWNER");
    if (owners.length > 1) {
      issues.push(
        `seriesInstances: series ${entry.seriesId} has ${String(owners.length)} OWNER instances; every window would have two live owners (§6 invariant 11, ADR-011)`,
      );
    }
  }
  for (const instance of seriesInstances) {
    if (!seriesIds.includes(instance.seriesId)) {
      issues.push(`seriesInstances: instance ${instance.instanceId} names series ${instance.seriesId}, which this document does not review`);
    }
  }
  const instanceIds = [...config.instances.map((instance) => instance.instanceId), ...seriesInstances.map((instance) => instance.instanceId)];
  if (new Set(instanceIds).size !== instanceIds.length) {
    issues.push("instances, seriesInstances: each instanceId may appear once across both lists");
  }
  const runIds = [...config.instances.map((instance) => instance.runId), ...seriesInstances.map((instance) => instance.runId)];
  if (seriesInstances.length > 0 && new Set(runIds).size !== runIds.length) {
    issues.push("instances, seriesInstances: each runId may appear once when a series-bound instance runs (its run's evaluation sequence is its own)");
  }
  for (const entry of series) {
    if (!seriesConfigHash(entry).ok) issues.push(`series: ${entry.seriesId} cannot be canonicalized for its configuration hash`);
  }
  if (issues.length === 0) return undefined;
  return {
    code: "TRADER_CONFIG_INCONSISTENT",
    detail:
      "the series fields of the trader configuration do not describe a runnable document (ROLLOVER-1, ADR-030): " +
      "refused rather than repaired",
    issues,
  };
}

/** `ROLLOVER-1`: one configured reviewed series with its configuration hash. */
export interface ConfiguredSeries {
  readonly series: ReviewedSeries;
  readonly configHash: string;
}

/**
 * `ROLLOVER-1`: the configured reviewed series with their configuration hashes,
 * in document order. A parsed configuration's series always canonicalize
 * ({@link seriesRefusal}), so this never answers fewer than it was given.
 */
export function configuredSeries(config: TraderConfig): readonly ConfiguredSeries[] {
  return (config.series ?? []).flatMap((series) => {
    const hash = seriesConfigHash(series);
    return hash.ok ? [{ series, configHash: hash.hash }] : [];
  });
}
