/**
 * The composition root itself: `createPaperTrader`.
 *
 * Everything below is WIRING. There is no rule here that a merged package does
 * not already own — the file's whole content is: check safety, parse the
 * configuration through its door, construct one instance of each component, and
 * refuse to return a trader if any of that fails.
 *
 * ## The startup order, and why it is this order
 *
 * 1. **Safety first, before anything reads anything.** §6 invariant 17 rejects
 *    a configuration that could load a real key, and a process that has already
 *    read one has already failed the invariant. So `checkPaperTraderSafety` runs
 *    on the environment record before the configuration is even parsed.
 * 2. **The configuration door.** ADR-020 D1-D4 (`config.ts`).
 * 3. **The risk policy and the allocator caps through THEIR OWN doors.**
 *    `parseRiskPolicy` and `parseAllocatorCaps` are the canonical D1-D4 doors
 *    for those documents, and their `.default()` values come from bound tables
 *    precisely because a defeated default silently disabled §9.8 checks 2, 6
 *    and 12 in `packages/risk`'s own review. Re-implementing either here would
 *    put a second authority on the safety policy.
 * 4. **Instances, with the §8.2 order fixed and the §6 invariant 11 conflict
 *    refused.** Each instance's own params are validated by the STRATEGY's
 *    validator, not by a copy of it.
 * 5. **The venue last**, because it is the only component that could ever be
 *    replaced by something with a network surface, and constructing it last
 *    makes the dependency direction obvious.
 *
 * ## What cannot be constructed here
 *
 * A trader whose venue places real orders. The type of `venue` is the §12.1
 * `ExecutionVenue` surface, the only implementation this repository has is
 * `packages/simulation`'s — which refuses `EXECUTION_PROBE`, `LIVE_MICRO` and
 * `LIVE` by name — and `safety.ts` refuses to start under any run mode that
 * would need one. Three independent refusals, none of which this file weakens.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy, type RiskPolicy } from "@polymarket-bot/risk";
import {
  createRunEvaluationSequence,
  createStrategyInstanceRuntime,
  type CheckpointStore,
  type DecisionSink,
  type MonotonicClock,
  type RunEvaluationSequence,
} from "@polymarket-bot/strategy-runtime";
import {
  staticBracketParamsSchema,
  staticBracketStrategy,
  validateStaticBracketParams,
} from "@polymarket-bot/strategy-static-bracket";

import { DeterministicIdFactory, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import { evaluationCadenceProblem, type CadenceAlarm, type EvaluationCadenceOption } from "./cadence.js";
import {
  configuredFeatureKeys,
  configuredSeries,
  parseTraderConfig,
  type SeriesInstanceConfig,
  type TraderConfig,
} from "./config.js";
import { accountingChecksProblem, type AccountingChecks } from "./folds.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry, type InstanceRegistration } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer, type TraderVenue } from "./loop.js";
import { MarketState } from "./market-state.js";
import { retentionBoundsProblem, type RetentionBounds } from "./order-lifecycle.js";
import type { Clock, TraderStore } from "./ports.js";
import {
  checkPaperTraderSafety,
  REPOSITORY_MAXIMUM_RUN_MODE,
  TRADER_RUN_MODE,
  type Environment,
} from "./safety.js";
import { admissionRunModeProblem } from "./series.js";
import { SeriesWindowAdmissions, type AdmissionNotice } from "./series-admission.js";
import { normalizeToStrictUtc } from "./time.js";

export interface CreateTraderOptions {
  /** The environment record. NEVER `process.env` read from inside this module. */
  readonly env: Environment;
  /** The operator configuration document, unparsed. */
  readonly config: unknown;
  readonly clock: Clock;
  readonly venue: TraderVenue;
  readonly store: TraderStore;
  /**
   * The run-scoped namespace every derived identifier is minted from.
   *
   * Two runs with the same namespace mint the same ids, which is what makes a
   * §12.4 byte-identical comparison of two runs possible at all.
   */
  readonly idNamespace: string;
  /** Maximum trades kept per market for the feature window. */
  readonly maximumTradesPerMarket?: number;
  /**
   * `TRDR-4` — the core loop's retention bounds (decisions, traces,
   * provenance, tombstones). Omitted fields take `DEFAULT_RETENTION`
   * (`order-lifecycle.ts`), which sits far above every fixture; a caller sets
   * one only to exercise eviction.
   */
  readonly retention?: RetentionBounds;
  /**
   * `FOLD-1` — the core loop's rebuild-check cadence (`folds.ts`). Omitted:
   * the PAPER cadence (the ledger every 50 posted fills, plus the shutdown
   * check `main.ts` runs; no PnL check — user ruling F2). The test and golden
   * harnesses pass `EVERY_FILL_ACCOUNTING_CHECKS` IN CODE (orchestrator call
   * O1); it is not part of the configuration document.
   */
  readonly accountingChecks?: AccountingChecks;
  /**
   * `CADENCE-1` — the ADR-026 evaluation cadence (`cadence.ts`). Omitted: the
   * PAPER cadence, 1,000 ms and 5,000 ms — what every live-data run and every
   * replay that is not a reproduction uses (D1.5). The live composition root
   * (`apps/trader` `main.ts`) passes it explicitly, after its registration
   * check has read the same two values from the run's `strategy.runs` row. The
   * per-frame value 0 is accepted only with `reproduces` (D1.6), which only a
   * golden harness or `backtest-cli run --reproduces` sets. Anything else is
   * refused, `TRADER_CADENCE_REFUSED`. Not part of the configuration document.
   */
  readonly evaluationCadence?: EvaluationCadenceOption;
  /**
   * `CADENCE-1` (ADR-026 D2.10) — told when a forward-jump alarm episode starts
   * or ends; the live root logs the line an operator's pager watches. Output
   * only.
   */
  readonly onCadenceAlarm?: (alarm: CadenceAlarm) => void;
  /**
   * `ROLLOVER-1` (ADR-030) — told of every series-window admission, refusal and
   * teardown; the live root logs them. Output only.
   */
  readonly onAdmission?: (notice: AdmissionNotice) => void;
}

export interface TraderRefusal {
  readonly code:
    | "TRADER_UNSAFE_ENVIRONMENT"
    | "TRADER_CONFIG_REFUSED"
    | "TRADER_CADENCE_REFUSED"
    | "TRADER_RISK_POLICY_REFUSED"
    | "TRADER_ALLOCATOR_CAPS_REFUSED"
    | "TRADER_MARKET_INVALID"
    | "TRADER_INSTANCE_INVALID"
    /** `ROLLOVER-1`: series admission may not run in this process's mode (ADR-030 Decision 2.1). */
    | "TRADER_ADMISSION_REFUSED"
    | "TRADER_LEDGER_REFUSED";
  readonly detail: string;
  readonly issues: readonly string[];
}

export interface PaperTrader {
  readonly loop: CoreLoop;
  readonly registry: InstanceRegistry;
  /**
   * The assembled per-market state.
   *
   * Published because a composition root's parts are what an operational
   * surface reads: `WP-240`'s control API and dashboards need the books and the
   * lifecycle, and a process that hid them would force that package to rebuild
   * state it does not own. The map is the LIVE one the loop holds, so a reader
   * sees the current book rather than a stale copy.
   */
  readonly markets: ReadonlyMap<string, MarketState>;
  readonly health: HealthState;
  readonly halts: HaltController;
  readonly config: TraderConfig;
  readonly riskPolicy: RiskPolicy;
  /** The §8.2 run manifest, recorded as the handoff requires. */
  readonly manifest: ReturnType<InstanceRegistry["manifest"]>;
  /**
   * `ROLLOVER-1` (ADR-030): the run's series admissions, when the
   * configuration reviews a series. The admitted windows join {@link markets}
   * and {@link registry} as they are admitted, and leave both at teardown.
   */
  readonly admission: SeriesWindowAdmissions | undefined;
}

export type CreateTraderResult =
  | { readonly ok: true; readonly trader: PaperTrader }
  | { readonly ok: false; readonly refusal: TraderRefusal };

function refuse(
  code: TraderRefusal["code"],
  detail: string,
  issues: readonly string[] = [],
): CreateTraderResult {
  return { ok: false, refusal: { code, detail, issues } };
}

/**
 * The per-field issues a package's refusal carries.
 *
 * Pulled out rather than dropped, because a startup refusal whose message says
 * "failed validation" and nothing else forces an operator to guess which field
 * was wrong — and guessing at a SAFETY policy's shape is exactly the failure
 * mode this process exists to prevent.
 */
function detailIssues(details: unknown): readonly string[] {
  if (typeof details !== "object" || details === null) return [];
  if (!Object.hasOwn(details, "issues")) return [];
  const issues = (details as Record<string, unknown>)["issues"];
  return Array.isArray(issues) ? issues.map((issue) => String(issue)) : [];
}

/**
 * C1-RISK (the user's ruling, 2026-10-08): the six per-scope exposure caps
 * `riskPolicy.limits` used to carry, and the `allocatorCaps` field that states
 * each now. The capital allocator is the only exposure-cap authority, and
 * `packages/risk`'s `limits` is strict, so a configuration still naming one is
 * refused at startup. This table only makes that refusal say where the cap
 * went; it accepts nothing.
 */
const RETIRED_RISK_EXPOSURE_CAPS: Readonly<Record<string, string>> = Object.freeze({
  globalExposureCap: "globalAccountCap",
  perInstanceExposureCap: "perStrategyCap",
  perMarketExposureCap: "perMarketCap",
  perSeriesExposureCap: "perSeriesCap",
  perUnderlyingExposureCap: "perUnderlyingCap",
  perResolutionWindowExposureCap: "perResolutionWindowCap",
});

/** One line per retired cap the document's `riskPolicy.limits` still states, naming its `allocatorCaps` field. */
function retiredExposureCapIssues(riskPolicy: unknown): readonly string[] {
  // The configuration is the door's materialized tree: own data, no accessor.
  if (typeof riskPolicy !== "object" || riskPolicy === null || !Object.hasOwn(riskPolicy, "limits")) return [];
  const limits = (riskPolicy as Record<string, unknown>)["limits"];
  if (typeof limits !== "object" || limits === null) return [];
  return Object.keys(RETIRED_RISK_EXPOSURE_CAPS)
    .filter((name) => Object.hasOwn(limits, name))
    .map(
      (name) =>
        `riskPolicy.limits.${name} is retired: the capital allocator is the only exposure-cap ` +
        `authority (C1-RISK, 2026-10-08), so state this cap as allocatorCaps.` +
        `${RETIRED_RISK_EXPOSURE_CAPS[name] ?? "?"} and delete it from riskPolicy.limits`,
    );
}

/**
 * Builds a PAPER trader, or refuses.
 *
 * TOTAL: never throws. A composition root that threw on a bad configuration
 * would produce a stack trace where an operator needs a list of what to fix.
 */
export function createPaperTrader(options: CreateTraderOptions): CreateTraderResult {
  // --- 1. safety, before anything else ------------------------------------
  const safety = checkPaperTraderSafety(options.env);
  if (!safety.ok) {
    return refuse(
      "TRADER_UNSAFE_ENVIRONMENT",
      `the environment is not safe for a ${TRADER_RUN_MODE} trader; ${String(safety.violations.length)} ` +
        "violation(s). The process refuses to start rather than continue under a weakened default",
      safety.violations.map((violation) => `${violation.code}: ${violation.detail}`),
    );
  }

  // --- 2. the configuration door ------------------------------------------
  const parsed = parseTraderConfig(options.config);
  if (!parsed.ok) {
    return refuse("TRADER_CONFIG_REFUSED", parsed.refusal.detail, parsed.refusal.issues);
  }
  const config = parsed.config;

  // --- 3. the risk policy and allocator caps, through their own doors ------
  const policy = parseRiskPolicy(config.riskPolicy);
  if (!policy.ok) {
    return refuse(
      "TRADER_RISK_POLICY_REFUSED",
      "the §9.8 risk policy was refused by packages/risk's own door",
      [
        ...retiredExposureCapIssues(config.riskPolicy),
        ...policy.refusals.flatMap((refusal_) => [
          `${refusal_.code}: ${refusal_.message}`,
          ...detailIssues(refusal_.details),
        ]),
      ],
    );
  }
  const caps = parseAllocatorCaps(config.allocatorCaps);
  if (!caps.ok) {
    return refuse(
      "TRADER_ALLOCATOR_CAPS_REFUSED",
      "the §9.7 allocator caps were refused by packages/capital-allocator's own door — note " +
        "that both live-micro caps are FENCED at 0 there, so a non-zero one is refused by that " +
        "package and not by this one",
      caps.refusals.flatMap((refusal_) => [
        `${refusal_.code}: ${refusal_.message}`,
        ...detailIssues(refusal_.details),
      ]),
    );
  }

  // --- 4. markets ----------------------------------------------------------
  const markets = new Map<string, MarketState>();
  const tokenAssetIds = new Map<string, string>();
  const allocationMarkets = new Map<string, AllocationMarket>();
  for (const market of config.markets) {
    // Obligation 1: the configured lifecycle instants are normalised ONCE,
    // here, so every view downstream carries the strict-UTC form the strategy
    // demands and no evaluation pays for the conversion.
    const open = normalizeToStrictUtc(market.openTime);
    const close = normalizeToStrictUtc(market.closeTime);
    if (!open.ok || !close.ok) {
      return refuse(
        "TRADER_MARKET_INVALID",
        `market ${market.marketId} has a lifecycle instant the trader cannot normalise to ` +
          "strict UTC; an offset form is converted here and only here, and an unreadable one " +
          "is refused rather than guessed",
        [open.ok ? "" : `openTime: ${open.problem}`, close.ok ? "" : `closeTime: ${close.problem}`]
          .filter((issue) => issue.length > 0),
      );
    }
    markets.set(
      market.marketId,
      new MarketState({
        config: { ...market, openTime: open.instant, closeTime: close.instant },
        tradeWindowMs: config.features.tradeWindowMs,
        maximumTrades: options.maximumTradesPerMarket ?? 512,
      }),
    );
    // ADR-006 §7 rule 1: a token IS an asset, and it needs an explicit id.
    // Derived from the venue token id so the ledger's asset identity is stable
    // and traceable to the market it belongs to.
    tokenAssetIds.set(`${market.marketId}|YES`, `token:${market.yesTokenId}`);
    tokenAssetIds.set(`${market.marketId}|NO`, `token:${market.noTokenId}`);
    // §9.7's per-series / per-underlying / per-resolution-window scope, taken
    // from the operator's own market document. A market whose scope the caps
    // reference but the configuration does not state cannot exist: all three
    // keys are REQUIRED by `config.ts`, so a configured scope cap always has an
    // attribution and never falls into `CAPITAL_SCOPE_KEY_MISSING` by accident.
    allocationMarkets.set(market.marketId, allocationMarketOf(market));
  }

  // `TRDR-4`: the loop's retention bounds are a programmatic option, not part
  // of the configuration document, but this function is TOTAL — so a bound the
  // loop's constructor would throw on is refused here, by name.
  const retentionProblem =
    options.retention === undefined ? undefined : retentionBoundsProblem(options.retention);
  if (retentionProblem !== undefined) {
    return refuse(
      "TRADER_CONFIG_REFUSED",
      "the core loop's retention bounds were refused; an unbounded or zero-sized audit log is " +
        "not a bound",
      [retentionProblem],
    );
  }
  // `FOLD-1`: the same rule for the rebuild-check cadence — a programmatic
  // option the loop's constructor would throw on, refused here by name.
  const checksProblem =
    options.accountingChecks === undefined
      ? undefined
      : accountingChecksProblem(options.accountingChecks);
  if (checksProblem !== undefined) {
    return refuse(
      "TRADER_CONFIG_REFUSED",
      "the core loop's accounting rebuild-check cadence was refused; §6 invariant 8's check " +
        "needs a cadence it can keep",
      [checksProblem],
    );
  }

  // `CADENCE-1`: the evaluation cadence — the same rule, refused here by name.
  // ADR-026 D1.5-D1.6: 1,000 / 5,000, or 0 / 0 for a declared reproduction.
  const cadenceProblem =
    options.evaluationCadence === undefined ? undefined : evaluationCadenceProblem(options.evaluationCadence);
  if (cadenceProblem !== undefined) {
    return refuse(
      "TRADER_CADENCE_REFUSED",
      "the evaluation cadence was refused; a live-data run, and every replay that is not a reproduction, " +
        "uses exactly 1000 ms and 5000 ms (ADR-026 D1.5)",
      [cadenceProblem],
    );
  }

  // --- 5. the outbox, the ledger, and the counters -------------------------
  const outbox = new DecisionOutboxBuffer(config.queues.outboxMaximumDepth);
  const ledger = Ledger.empty(config.environment);
  const health = new HealthState({
    runMode: TRADER_RUN_MODE,
    maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE,
  });
  const halts = new HaltController();
  const ids = new DeterministicIdFactory(options.idNamespace);

  // --- 6. instances --------------------------------------------------------
  const registry = new InstanceRegistry();
  const monotonic: MonotonicClock = { nowNs: () => options.clock.monotonicNs() };
  const decisionSink: DecisionSink = {
    persist: (record, telemetry) => {
      outbox.appendDecision(record, telemetry);
    },
  };
  const checkpointStore: CheckpointStore = {
    save: (checkpoint) => {
      outbox.appendCheckpoint(checkpoint);
    },
  };

  for (const instance of config.instances) {
    // The STRATEGY's own validator, not a copy of it. A second implementation
    // of §13.2's grammar here would be a second authority that can drift.
    const params = validateStaticBracketParams(instance.params);
    if (!params.ok) {
      return refuse(
        "TRADER_INSTANCE_INVALID",
        `instance ${instance.instanceId} carries params the strategy refused`,
        [params.problem],
      );
    }
    if (!markets.has(instance.marketId)) {
      return refuse(
        "TRADER_INSTANCE_INVALID",
        `instance ${instance.instanceId} names market ${instance.marketId}, which this trader ` +
          "is not configured for",
      );
    }
    const created = createStrategyInstanceRuntime({
      strategy: staticBracketStrategy,
      params: instance.params,
      run: {
        runId: instance.runId,
        instanceId: instance.instanceId,
        configId: instance.configId,
        runSeed: instance.runSeed,
      },
      watchdog: { evaluationBudgetUs: instance.evaluationBudgetUs },
      clock: monotonic,
      decisionSink,
      checkpointStore,
    });
    if (!created.ok) {
      return refuse(
        "TRADER_INSTANCE_INVALID",
        `the runtime refused instance ${instance.instanceId}`,
        [`${created.refusal.code}: ${created.refusal.detail}`],
      );
    }
    const registered = registry.register({
      instanceId: instance.instanceId,
      runId: instance.runId,
      configId: instance.configId,
      marketId: instance.marketId,
      ownership: instance.ownership,
      evaluationPriority: instance.evaluationPriority,
      runtime: created.runtime,
      direction: params.value.market_selector.direction,
      params: params.value,
      immediateOrderType: params.value.entry.execution.immediate_order_type,
      submissionUnknownAfterMs: params.value.entry.execution.submission_unknown_after_ms,
    });
    if (!registered.ok) {
      return refuse("TRADER_INSTANCE_INVALID", registered.detail, [registered.code]);
    }
  }

  // The §9.7 allocator, built from the caps this root parsed. It is a
  // CONSTRUCTOR ARGUMENT of the loop rather than an optional collaborator: §8.1
  // places "allocate capital" before the risk checks and §9.8 check 14 fails
  // closed without its verdict, so a loop that could be built without one is a
  // loop that can fabricate the verdict (review round 1, HIGH-1).
  // `ROLLOVER-1` r1 (R1-01): built BEFORE the series admissions, so a window's
  // attach can make the window's assets known to it (`registerMarketAssets`).
  const allocator = new AllocatorGate({
    caps: caps.value,
    markets: allocationMarkets,
    tokenAssetIds,
  });

  // --- 6b. `ROLLOVER-1`: series-bound instances and the series admissions -----
  //
  // ADR-030 Decision 2.1: admission runs only in PAPER or BACKTEST. This
  // process is PAPER by construction (`safety.ts`), and the guard is applied
  // anyway, by name, so a mode the guard refuses can never construct one.
  let admission: SeriesWindowAdmissions | undefined;
  const reviewed = configuredSeries(config);
  if (reviewed.length > 0) {
    const modeProblem = admissionRunModeProblem(TRADER_RUN_MODE);
    if (modeProblem !== undefined) return refuse("TRADER_ADMISSION_REFUSED", modeProblem);
    const bound: {
      readonly instance: SeriesInstanceConfig;
      readonly params: Extract<ReturnType<typeof validateStaticBracketParams>, { readonly ok: true }>["value"];
      readonly sequence: RunEvaluationSequence;
    }[] = [];
    for (const instance of config.seriesInstances ?? []) {
      const params = validateStaticBracketParams(instance.params);
      if (!params.ok) {
        return refuse(
          "TRADER_INSTANCE_INVALID",
          `series-bound instance ${instance.instanceId} carries params the strategy refused`,
          [params.problem],
        );
      }
      // ONE evaluation sequence per run, shared by every window's runtime
      // (the user's ruling Q2). A trader start is a new run (ADR-030 Decision
      // 4.5), so it starts fresh at 0.
      bound.push({ instance, params: params.value, sequence: createRunEvaluationSequence() });
    }
    const maximumTrades = options.maximumTradesPerMarket ?? 512;
    admission = new SeriesWindowAdmissions({
      series: reviewed,
      isKnownMarket: (marketId, conditionId, tokenIds) => {
        if (markets.has(marketId)) return true;
        for (const market of markets.values()) {
          if (market.config.conditionId === conditionId) return true;
          if (tokenIds.includes(market.config.yesTokenId) || tokenIds.includes(market.config.noTokenId)) return true;
        }
        return false;
      },
      attachment: {
        attach: (window) => {
          const open = normalizeToStrictUtc(window.market.openTime);
          const close = normalizeToStrictUtc(window.market.closeTime);
          if (!open.ok || !close.ok) return { ok: false, detail: "the window's schedule is not a strict-UTC instant" };
          // The runtimes FIRST: a refusal leaves nothing of the window behind.
          const registrations: InstanceRegistration[] = [];
          for (const { instance, params, sequence } of bound) {
            if (instance.seriesId !== window.seriesId) continue;
            const created = createStrategyInstanceRuntime({
              strategy: staticBracketStrategy,
              params: instance.params,
              run: {
                runId: instance.runId,
                instanceId: instance.instanceId,
                configId: instance.configId,
                runSeed: instance.runSeed,
              },
              watchdog: { evaluationBudgetUs: instance.evaluationBudgetUs },
              clock: monotonic,
              decisionSink,
              checkpointStore,
              sequence,
            });
            if (!created.ok) return { ok: false, detail: `${created.refusal.code}: ${created.refusal.detail}` };
            registrations.push({
              window: true,
              instanceId: instance.instanceId,
              runId: instance.runId,
              configId: instance.configId,
              marketId: window.marketId,
              ownership: instance.ownership,
              evaluationPriority: instance.evaluationPriority,
              runtime: created.runtime,
              direction: params.market_selector.direction,
              params,
              immediateOrderType: params.entry.execution.immediate_order_type,
              submissionUnknownAfterMs: params.entry.execution.submission_unknown_after_ms,
            });
          }
          // `ROLLOVER-1` r1 (R1-01): the window's assets are known to the
          // allocator BEFORE any runtime of it is registered, so its booked
          // position is inventory an exit may sell and exposure every §9.7
          // cap counts. A clash refuses the window with nothing attached.
          const yesAssetId = `token:${window.yesTokenId}`;
          const noAssetId = `token:${window.noTokenId}`;
          if (!allocator.registerMarketAssets(window.marketId, yesAssetId, noAssetId)) {
            return { ok: false, detail: "the window's token assets are already mapped to another market or side" };
          }
          const marketConfig = { ...window.market, openTime: open.instant, closeTime: close.instant };
          markets.set(
            window.marketId,
            new MarketState({ config: marketConfig, tradeWindowMs: config.features.tradeWindowMs, maximumTrades }),
          );
          tokenAssetIds.set(`${window.marketId}|YES`, yesAssetId);
          tokenAssetIds.set(`${window.marketId}|NO`, noAssetId);
          allocationMarkets.set(window.marketId, allocationMarketOf(marketConfig));
          for (const registration of registrations) {
            const registered = registry.register(registration);
            if (!registered.ok) {
              registry.retireMarket(window.marketId);
              markets.delete(window.marketId);
              return { ok: false, detail: `${registered.code}: ${registered.detail}` };
            }
          }
          return { ok: true };
        },
        detach: (window) => {
          // Books, features and strategy state go; the token assets (the
          // loop's map and the allocator's, R1-01) and the allocation scope
          // stay with the ledger rows that name them.
          registry.retireMarket(window.marketId);
          markets.delete(window.marketId);
        },
      },
    });
  }

  const posting: PostingIdentity = {
    environment: config.environment,
    accountRef: config.accounting.accountRef,
    denominationAssetId: config.accounting.denominationAssetId,
    venueClearingRef: config.accounting.venueClearingRef,
    attributionClearingRef: config.accounting.attributionClearingRef,
    feeExpenseRef: config.accounting.feeExpenseRef,
  };

  const loop = new CoreLoop({
    config,
    riskPolicy: policy.value,
    allocator,
    clock: options.clock,
    venue: options.venue,
    store: options.store,
    registry,
    markets,
    instanceConfigs: new Map(
      config.instances.map((instance) => [instance.instanceId, instance]),
    ),
    ledger,
    ids,
    health,
    halts,
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    ...(options.accountingChecks === undefined
      ? {}
      : { accountingChecks: options.accountingChecks }),
    ...(options.evaluationCadence === undefined ? {} : { evaluationCadence: options.evaluationCadence }),
    ...(options.onCadenceAlarm === undefined ? {} : { onCadenceAlarm: options.onCadenceAlarm }),
    ...(admission === undefined ? {} : { admission }),
    ...(options.onAdmission === undefined ? {} : { onAdmission: options.onAdmission }),
  });

  void staticBracketParamsSchema;

  return {
    ok: true,
    trader: {
      loop,
      registry,
      markets,
      health,
      halts,
      config,
      riskPolicy: policy.value,
      manifest: registry.manifest(),
      admission,
    },
  };
}
