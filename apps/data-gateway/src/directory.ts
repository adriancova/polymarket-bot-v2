/**
 * The gateway's `PublicMarketDirectory`, backed by the WP-110 universe
 * registry.
 *
 * This is the composition point WP-070 named ("`WP-110` implements
 * `PublicMarketDirectory`" — the pure functions exist in
 * `@polymarket-bot/universe`; wiring them behind the adapter's port is a
 * layer-3 job, and this is layer 3).
 *
 * Three port methods, three decisions:
 *
 * - `identityForToken` → `findMarketByTokenId` over the seeded registry.
 * - `registerDiscoveredMarket` → **REFUSED** (returns `undefined`). §9.2:
 *   series binding and market adoption are configuration, not heuristics, and
 *   the venue publishes `assets_ids` and `outcomes` as two arrays with NO
 *   documented pairing rule — the gateway has no basis to decide which token
 *   is YES. The observation is retained (bounded) and surfaced through
 *   metrics; the adapter reports `UNREGISTERED_MARKET`, which the feed driver
 *   routes as a LOG-severity incident. Nothing is silent, nothing is invented.
 * - `assignTradingParameterVersion` → `recordMarketParameters`: an observed
 *   tick-size change becomes the next immutable parameter version, and the
 *   returned `parametersVersion` / `parameterVersionRef` are the catalogue's
 *   own (§6 invariant 9, ADR-002 §6) — the gateway invents neither.
 *
 * SETTLEMENT VERDICTS ARE NOT CONSUMED HERE. The gateway records data; it
 * activates nothing, so `SettlementActivationVerdict` never reaches this
 * process and the WP-110 narrowing obligation
 * (`narrowSettlementActivationVerdict` → `SettlementActivationView`) falls to
 * the composition roots that do consume it (`WP-160`/`WP-170`). Stated here
 * and in the WP-120 handoff so the obligation is handed on, not dropped.
 */

import type {
  ObservedNewMarket,
  ObservedTickSizeChange,
  PublicMarketDirectory,
  PublicMarketIdentity,
  TradingParameterVersionAssignment,
} from "@polymarket-bot/polymarket-public";
import type { UniverseRegistry } from "@polymarket-bot/universe";
import {
  createUniverseRegistry,
  findMarketByTokenId,
  recordMarketParameters,
  registerMarket,
} from "@polymarket-bot/universe";

import type { MarketConfig } from "./config.js";
import { GatewayConfigurationError } from "./errors.js";
import type { GatewayClock } from "./ports.js";
import { isoFromMs } from "./ports.js";

/** Bounded memory of announcements the directory declined. */
const MAX_RETAINED_OBSERVATIONS = 256;

export interface UniverseDirectoryMetrics {
  readonly knownMarkets: number;
  readonly declinedRegistrations: number;
  readonly parameterVersionsAssigned: number;
  readonly parameterAssignmentsDeclined: number;
}

export class UniverseMarketDirectory implements PublicMarketDirectory {
  #registry: UniverseRegistry;
  readonly #clock: GatewayClock;
  readonly #declined: ObservedNewMarket[] = [];
  #declinedCount = 0;
  #versionsAssigned = 0;
  #assignmentsDeclined = 0;

  constructor(markets: readonly MarketConfig[], clock: GatewayClock) {
    this.#clock = clock;
    let registry = createUniverseRegistry();
    for (const market of markets) {
      const result = registerMarket(registry, {
        identity: {
          internalMarketId: market.internalMarketId,
          conditionId: market.conditionId,
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
        },
        parameters: {
          parameters: {
            tickSize: market.parameters.tickSize,
            minimumOrderSize: market.parameters.minimumOrderSize,
            negRisk: market.parameters.negRisk,
            tradingDelaySeconds: market.parameters.tradingDelaySeconds,
            status: market.parameters.status,
            ...(market.parameters.feeScheduleRef === undefined
              ? {}
              : { feeScheduleRef: market.parameters.feeScheduleRef }),
            ...(market.parameters.openTime === undefined
              ? {}
              : { openTime: market.parameters.openTime }),
            ...(market.parameters.closeTime === undefined
              ? {}
              : { closeTime: market.parameters.closeTime }),
          },
          observedAt: market.observedAt,
          source: "polymarket",
        },
      });
      if (!result.ok) {
        throw new GatewayConfigurationError(
          "a configured market was refused by the universe registry",
          {
            internalMarketId: market.internalMarketId,
            refusals: result.refusals.map((refusal) => `${refusal.code}: ${refusal.message}`),
          },
        );
      }
      registry = result.value.registry;
    }
    this.#registry = registry;
  }

  identityForToken(tokenId: string): PublicMarketIdentity | undefined {
    const projection = findMarketByTokenId(this.#registry, tokenId);
    if (projection === undefined) {
      return undefined;
    }
    return {
      internalMarketId: projection.identity.internalMarketId,
      conditionId: projection.identity.conditionId,
      yesTokenId: projection.identity.yesTokenId,
      noTokenId: projection.identity.noTokenId,
    };
  }

  registerDiscoveredMarket(observation: ObservedNewMarket): undefined {
    this.#declinedCount += 1;
    this.#declined.push(observation);
    if (this.#declined.length > MAX_RETAINED_OBSERVATIONS) {
      this.#declined.shift();
    }
    return undefined;
  }

  assignTradingParameterVersion(
    change: ObservedTickSizeChange,
  ): TradingParameterVersionAssignment | undefined {
    const projection = findMarketByTokenId(this.#registry, change.tokenId);
    if (projection === undefined) {
      this.#assignmentsDeclined += 1;
      return undefined;
    }
    const previous = projection.parameters.versions.at(-1);
    if (previous === undefined) {
      this.#assignmentsDeclined += 1;
      return undefined;
    }
    const result = recordMarketParameters(
      this.#registry,
      projection.identity.internalMarketId,
      {
        parameters: { ...previous.parameters, tickSize: change.tickSize },
        observedAt: change.observedAt ?? isoFromMs(this.#clock.nowMs()),
        source: "polymarket",
      },
    );
    if (!result.ok) {
      // A no-op or out-of-order observation is refused by the catalogue; the
      // adapter reports `UNASSIGNED_PARAMETER_VERSION` and the driver routes
      // it. Declining here is loud downstream, never silent.
      this.#assignmentsDeclined += 1;
      return undefined;
    }
    this.#registry = result.value.registry;
    this.#versionsAssigned += 1;
    const version = result.value.version;
    return {
      parametersVersion: version.parametersVersion,
      ...(version.previousParametersVersion === undefined
        ? {}
        : { previousParametersVersion: version.previousParametersVersion }),
      parameterVersionRef: version.parameterVersionRef,
    };
  }

  /** Announcements the directory declined, oldest first (bounded). */
  get declinedRegistrations(): readonly ObservedNewMarket[] {
    return this.#declined;
  }

  metrics(): UniverseDirectoryMetrics {
    return {
      knownMarkets: this.#registry.markets.size,
      declinedRegistrations: this.#declinedCount,
      parameterVersionsAssigned: this.#versionsAssigned,
      parameterAssignmentsDeclined: this.#assignmentsDeclined,
    };
  }
}
