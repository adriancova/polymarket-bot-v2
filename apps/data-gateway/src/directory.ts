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
 * `ROLLOVER-1` (ADR-030): a window ADMITTED from a reviewed series is the
 * one market this directory learns after construction. It does not come from
 * `registerDiscoveredMarket` — the `new_market` push stays declined: its
 * delivery scope is undocumented (U-23) and its arrays carry no documented
 * pairing (F-13) — but from the series-admission feed
 * (`feeds/series-admission.ts`), which judged the window against reviewed
 * configuration from the documented Gamma and CLOB reads, Gamma's index
 * pairing (F-01) cross-checked against the CLOB's explicit one (F-03).
 * {@link UniverseMarketDirectory.registerAdmittedWindow} adds it, each window
 * in its OWN universe registry so a torn-down window is RELEASED whole
 * ({@link UniverseMarketDirectory.releaseAdmittedWindow}) and the directory
 * stays bounded by the live windows (§8.3). A window never shadows a
 * configured market: a token or condition id already known is refused.
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
  /** `ROLLOVER-1`: admitted series windows currently registered (live, not torn down). */
  readonly admittedWindows: number;
  readonly admittedWindowsReleased: number;
  readonly declinedRegistrations: number;
  /**
   * Declined announcements the bounded memory has dropped (round-1 review L4).
   *
   * `declinedRegistrations` counts every announcement ever declined;
   * `declinedRegistrationsRetained` is how many of them a diagnosing operator
   * can still read. Without this third number, the retained list silently
   * stops being the whole story — §8.3's rule is that every bound is loud, and
   * a bound with no counter is not.
   */
  readonly declinedRegistrationsRetained: number;
  readonly declinedRegistrationsEvicted: number;
  /** The retention bound itself, so the two counts above can be read against it. */
  readonly declinedRegistrationsCapacity: number;
  readonly parameterVersionsAssigned: number;
  readonly parameterAssignmentsDeclined: number;
}

/** What {@link UniverseMarketDirectory.registerAdmittedWindow} needs to register one window. */
export interface AdmittedWindowRegistration {
  readonly internalMarketId: string;
  readonly conditionId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly tickSize: string;
  readonly minimumOrderSize: string;
  readonly negRisk: boolean;
  readonly tradingDelaySeconds: number;
  readonly openTime: string;
  readonly closeTime: string;
  readonly observedAt: string;
}

export type AdmittedWindowRegistrationResult =
  | { readonly ok: true; readonly parameterVersionRef: string; readonly parametersVersion: number }
  | { readonly ok: false; readonly detail: string };

export class UniverseMarketDirectory implements PublicMarketDirectory {
  #registry: UniverseRegistry;
  /** `ROLLOVER-1`: one universe registry per admitted window, by internal market id. */
  readonly #admitted = new Map<string, UniverseRegistry>();
  /** `ROLLOVER-1`: token id → the admitted window's internal market id. */
  readonly #admittedTokens = new Map<string, string>();
  #admittedReleased = 0;
  readonly #clock: GatewayClock;
  readonly #declined: ObservedNewMarket[] = [];
  #declinedCount = 0;
  #declinedEvicted = 0;
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
    const projection = findMarketByTokenId(this.#registryForToken(tokenId), tokenId);
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
      // Bounded memory, LOUDLY bounded: the oldest observation leaves and the
      // eviction is counted, so `declinedRegistrations` never silently
      // disagrees with what `declinedRegistrations` (the list) still holds.
      this.#declined.shift();
      this.#declinedEvicted += 1;
    }
    return undefined;
  }

  assignTradingParameterVersion(
    change: ObservedTickSizeChange,
  ): TradingParameterVersionAssignment | undefined {
    const admittedId = this.#admittedTokens.get(change.tokenId);
    const registry = this.#registryForToken(change.tokenId);
    const projection = findMarketByTokenId(registry, change.tokenId);
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
      registry,
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
    if (admittedId === undefined) this.#registry = result.value.registry;
    else this.#admitted.set(admittedId, result.value.registry);
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

  /** The configured registry, or the admitted window's own for one of its tokens. */
  #registryForToken(tokenId: string): UniverseRegistry {
    if (findMarketByTokenId(this.#registry, tokenId) !== undefined) return this.#registry;
    const admittedId = this.#admittedTokens.get(tokenId);
    return (admittedId === undefined ? undefined : this.#admitted.get(admittedId)) ?? this.#registry;
  }

  /**
   * `ROLLOVER-1`: whether a condition id or token is already KNOWN — a
   * configured market's or a live admitted window's. Admission never shadows
   * either.
   */
  knowsMarket(conditionId: string, tokenIds: readonly string[]): boolean {
    for (const projection of this.#registry.markets.values()) {
      if (projection.identity.conditionId === conditionId) return true;
    }
    for (const registry of this.#admitted.values()) {
      for (const projection of registry.markets.values()) {
        if (projection.identity.conditionId === conditionId) return true;
      }
    }
    return tokenIds.some(
      (tokenId) => this.#admittedTokens.has(tokenId) || findMarketByTokenId(this.#registry, tokenId) !== undefined,
    );
  }

  /**
   * `ROLLOVER-1`: registers one ADMITTED window (module header) and answers its
   * first parameter version. Refused when its id, condition id or either token
   * is already known, or when the universe registry refuses it.
   */
  registerAdmittedWindow(window: AdmittedWindowRegistration): AdmittedWindowRegistrationResult {
    if (this.#admitted.has(window.internalMarketId)) {
      return { ok: false, detail: `window ${window.internalMarketId} is already registered` };
    }
    if (this.knowsMarket(window.conditionId, [window.yesTokenId, window.noTokenId])) {
      return {
        ok: false,
        detail: `condition ${window.conditionId} or one of its tokens is already known to the directory; an admitted window never shadows a known market`,
      };
    }
    const result = registerMarket(createUniverseRegistry(), {
      identity: {
        internalMarketId: window.internalMarketId,
        conditionId: window.conditionId,
        yesTokenId: window.yesTokenId,
        noTokenId: window.noTokenId,
      },
      parameters: {
        parameters: {
          tickSize: window.tickSize,
          minimumOrderSize: window.minimumOrderSize,
          negRisk: window.negRisk,
          tradingDelaySeconds: window.tradingDelaySeconds,
          status: "DISCOVERED",
          openTime: window.openTime,
          closeTime: window.closeTime,
        },
        observedAt: window.observedAt,
        source: "polymarket",
      },
    });
    if (!result.ok) {
      return {
        ok: false,
        detail: result.refusals.map((refusal) => `${refusal.code}: ${refusal.message}`).join("; "),
      };
    }
    const projection = result.value.registry.markets.get(window.internalMarketId);
    const first = projection?.parameters.versions.at(0);
    if (first === undefined) {
      return { ok: false, detail: "the universe registry recorded no first parameter version" };
    }
    this.#admitted.set(window.internalMarketId, result.value.registry);
    this.#admittedTokens.set(window.yesTokenId, window.internalMarketId);
    this.#admittedTokens.set(window.noTokenId, window.internalMarketId);
    return { ok: true, parameterVersionRef: first.parameterVersionRef, parametersVersion: first.parametersVersion };
  }

  /** `ROLLOVER-1`: releases a torn-down window whole. Answers whether it was registered. */
  releaseAdmittedWindow(internalMarketId: string): boolean {
    const registry = this.#admitted.get(internalMarketId);
    if (registry === undefined) return false;
    this.#admitted.delete(internalMarketId);
    for (const [tokenId, owner] of [...this.#admittedTokens]) {
      if (owner === internalMarketId) this.#admittedTokens.delete(tokenId);
    }
    this.#admittedReleased += 1;
    return true;
  }

  /** Announcements the directory declined, oldest first (bounded). */
  get declinedRegistrations(): readonly ObservedNewMarket[] {
    return this.#declined;
  }

  metrics(): UniverseDirectoryMetrics {
    return {
      knownMarkets: this.#registry.markets.size,
      admittedWindows: this.#admitted.size,
      admittedWindowsReleased: this.#admittedReleased,
      declinedRegistrations: this.#declinedCount,
      declinedRegistrationsRetained: this.#declined.length,
      declinedRegistrationsEvicted: this.#declinedEvicted,
      declinedRegistrationsCapacity: MAX_RETAINED_OBSERVATIONS,
      parameterVersionsAssigned: this.#versionsAssigned,
      parameterAssignmentsDeclined: this.#assignmentsDeclined,
    };
  }
}
