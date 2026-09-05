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

import { readPlainData } from "@polymarket-bot/risk/plain-data";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";

/** A positive integer bound in milliseconds, small enough to be a real bound. */
const BoundedMs = z.number().int().positive().max(86_400_000);
const BoundedDepth = z.number().int().positive().max(1_000_000);
const CanonicalDecimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u, {
  message: "must be a canonical decimal string (§6 invariant 1; no exponent, no leading +)",
});
const NonNegativeDecimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, {
  message: "must be a canonical non-negative decimal string",
});
const Identifier = z.string().min(1).max(200);
/**
 * The `packages/domain` `CodeString` grammar, restated here as a REFUSAL at the
 * trader's own door.
 *
 * `packages/risk`'s evaluation input types `context.strategyInstanceId` and
 * every `ScopeAttribution` key as `CodeString` — "must be an alphanumeric code
 * without whitespace", and the pattern requires a LETTER first
 * (`^[A-Za-z][A-Za-z0-9_.:-]*$`). A configuration that violates it produces a
 * `RISK_INPUT_INVALID` refusal on the first intent, mid-run, with no order
 * placed and nothing to point the operator at. Refusing it HERE turns that into
 * a startup failure naming the field.
 *
 * See `README.md` for the reported cross-package conflict this exposes: a
 * genuinely-minted UUIDv7 begins with the digit `0` for every timestamp this
 * century, so it satisfies `packages/ledger`'s `Uuidv7Schema` and FAILS
 * `packages/risk`'s `CodeStringSchema` — the two doors cannot both be satisfied
 * by one such identifier.
 */
const CodeString = z.string().min(1).max(200).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u, {
  message:
    "must be a §7 CodeString: a LETTER followed by alphanumerics, '_', '.', ':' or '-' " +
    "(packages/risk types the scope keys and the strategy instance id this way)",
});
const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, {
    message: "must be a canonical LOWERCASE UUID (ADR-016 §2: refused, never case-folded)",
  });

/**
 * An identifier that satisfies BOTH merged doors it must pass.
 *
 * ONE regex rather than `Uuid.and(CodeString)`, because the arena refuses an
 * `intersection` node by name — "a node it cannot copy is a parse it cannot
 * protect" — and a door that fell back to an unprotected assembly to express a
 * conjunction would be trading D2 for syntax.
 *
 * The conjunction is the UUID grammar with a LETTER first hex digit. It is
 * deliberately NARROWER than either door alone, and the refusal message says so,
 * because the narrowing is a REPORTED CROSS-PACKAGE CONFLICT and not a
 * preference: every UUIDv7 minted from a real timestamp this century begins with
 * `0`, which `packages/ledger` requires and `packages/risk` refuses.
 */
const UuidAndCodeString = z
  .string()
  .regex(/^[a-f][0-9a-f]{7}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, {
    message:
      "must be a canonical lowercase UUID whose FIRST hex digit is a letter (a-f). Two merged " +
      "doors constrain this one value and their intersection is this shape: " +
      "packages/ledger and packages/pnl require Uuidv7Schema, while packages/risk types " +
      "context.strategyInstanceId as CodeStringSchema, whose pattern requires a leading " +
      "letter. A UUIDv7 minted from a real timestamp begins with '0' and cannot satisfy both " +
      "— that is a reported cross-package conflict, and this door refuses at STARTUP rather " +
      "than letting it surface as a mid-run RISK_INPUT_INVALID with no order placed",
  });

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
   * A canonical lowercase UUIDv7 that ALSO satisfies the `CodeString` grammar.
   *
   * Both are required by doors this process must pass: `packages/ledger`'s
   * `AllocationClaim.instanceId` and `packages/pnl`'s `PnlOwner.instanceId` are
   * `Uuidv7Schema`, while `packages/risk`'s `context.strategyInstanceId` is
   * `CodeStringSchema`. The intersection is non-empty — a UUIDv7 whose first
   * hex digit is a LETTER satisfies both — and it is checked here so the
   * conflict surfaces at startup rather than as a mid-run risk refusal.
   */
  instanceId: UuidAndCodeString,
  runId: Uuid,
  configId: Uuid,
  /** Canonical unsigned integer string (§10.3 `runs.run_seed`). */
  runSeed: z.string().regex(/^(?:0|[1-9]\d*)$/u),
  marketId: Uuid,
  /** §6 invariant 11: exactly one `OWNER` per market in v1. */
  ownership: z.enum(["OWNER", "SHADOW"]),
  evaluationPriority: z.number().int().min(0).max(1_000_000),
  /** §9.6's evaluation-time watchdog. */
  evaluationBudgetUs: z.number().int().positive().max(60_000_000),
  /** The strategy's own §13.2 configuration, validated by the strategy itself. */
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
  /**
   * §6 invariant 6: how long an unconfirmed cancel may stay unresolved before
   * the root closes it as `SILENCE_EXCEEDED` (`WP-220` obligation 10).
   */
  submissionUnknownAfterMs: BoundedMs,
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
  /** Starting simulated cash. The venue books against it (§12.1). */
  startingCash: NonNegativeDecimal,
});

/** The infrastructure endpoints. Names only — no credential is representable. */
const InfrastructureConfigSchema = z.strictObject({
  /** Redis stream the gateway publishes normalized events to (ADR-003). */
  eventStream: Identifier,
  consumerId: Identifier,
  /** Maximum events per `poll`. Bounded (§8.3). */
  receiveBatchSize: z.number().int().positive().max(10_000),
  /**
   * §9.1's bounded retention, in events.
   *
   * ADR-003's Consequences: "Retention size is a **safety parameter**, not a
   * tuning knob. Retention shorter than the worst tolerated trader restart
   * converts an ordinary restart into a hard resync plus an
   * authoritative-snapshot cycle." Required, therefore, and undefaulted.
   */
  retentionMaxEvents: z.number().int().positive().max(10_000_000),
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
  infrastructure: InfrastructureConfigSchema,
  markets: z.array(MarketConfigSchema).min(1).max(1000).readonly(),
  instances: z.array(InstanceConfigSchema).min(1).max(1000).readonly(),
});

export type TraderConfig = Readonly<z.infer<typeof TraderConfigSchema>>;
export type MarketConfig = TraderConfig["markets"][number];
export type InstanceConfig = TraderConfig["instances"][number];

/** **D2** — the parsing copy, built and WARMED at module load. */
const TraderConfigDoor = prototypeFreeParser(TraderConfigSchema);

export interface ConfigRefusal {
  readonly code: "TRADER_CONFIG_NOT_DATA" | "TRADER_CONFIG_INVALID";
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
  return { ok: true, config: deepFreeze(materialized) as TraderConfig };
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
  for (const instance of config.instances) {
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
