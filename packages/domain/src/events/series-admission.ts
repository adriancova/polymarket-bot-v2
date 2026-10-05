/**
 * `SeriesWindowAdmitted@1` — one window of a REVIEWED series, admitted in PAPER
 * (ADR-030 Decisions 1-4; `ROLLOVER-1`).
 *
 * ## Why a new contract (the user's ruling Q1, 2026-10-04)
 *
 * ADR-030 Decision 3.2 asked `ROLLOVER-1` to publish an admission with the
 * existing §7.4 contracts, and Decision 3.3 to stop and ask when they cannot
 * carry it faithfully. They cannot: an admitted window's SCHEDULED open and
 * close are values the trader must hold before it can trade the window, and
 * `MarketDiscovered@1` has no time field, `TradingParametersChanged@1` names
 * `open_time`/`close_time` only as changed KINDS (it is "a vocabulary of what
 * changed, not a copy of the values"), and `MarketOpened`/`MarketClosing`
 * record OBSERVED transitions. `ROLLOVER-1`'s first implementer stopped there
 * (its stop report, B1); the user granted this contract (Q1). The existing
 * contracts are unchanged, and an admission still publishes
 * `MarketDiscovered@1` and `TradingParametersChanged@1` beside this one.
 *
 * ## The fields
 *
 * The eight the ruling names:
 *
 * - `internalMarketId`, `conditionId`: the market reference every lifecycle
 *   payload carries (`./market-lifecycle.ts`).
 * - `seriesId`: the REVIEWED series the window was admitted under — the
 *   configuration key, never a venue identifier (§9.2: "Series binding is
 *   configuration").
 * - `seriesConfigHash`: the sha256 (64 lowercase hex) of the reviewed series
 *   document the admission judged against. A consumer holding its own copy of
 *   the review compares the two, so a gateway and a trader that disagree about
 *   what was reviewed cannot agree to trade a window (ADR-030 Decision 4.2: the
 *   run pins the series through its configuration).
 * - `yesTokenId`, `noTokenId`: the window's two outcome tokens, YES first.
 * - `scheduledOpenAt`, `scheduledCloseAt`: the window's SCHEDULED interval.
 *   These are schedule values, not observations: `MarketOpened` and
 *   `MarketClosing` still record the observed transitions.
 *
 * And two more, each needed by a consumer and justified here:
 *
 * - `tickSize`: the window's tick size at admission. The venue changes a
 *   market's tick size at run time, near the price limits
 *   (`docs/venue/verified-2026-10-04.md` F-21), so it is PER-WINDOW data,
 *   never a reviewed series constant (ruling Q3), and a trader cannot price an
 *   order for the window without it. Version 1 of the window's parameters;
 *   later changes travel on `TradingParametersChanged`, as for every market.
 * - `windowTitle`: the venue's title for the window, verbatim. The rules make
 *   the title's ET range the window (`verified-2026-10-04.md` F-16), so the
 *   title is the AUTHORITY the schedule above was derived from (ruling Q3); a
 *   consumer re-derives the interval from it rather than trusting the
 *   producer's arithmetic. It is also the market's question text, which the
 *   trader's catalog row requires.
 *
 * Like every contract in this package the payload is strict, carries no
 * JavaScript number for an economic value (`tickSize` is a decimal string), and
 * freezes no volatile venue fact beyond the identifiers it names. Cross-field
 * rules (distinct tokens; the close after the open; the interval the title
 * states) are the consumer's judgement, as they are for `MarketDiscovered@1`.
 */

import { z } from "zod";

import { PositiveDecimalStringSchema } from "../decimals.js";
import { ConditionIdSchema, InternalMarketIdSchema, TokenIdSchema } from "../identifiers.js";
import { CodeStringSchema, DetailStringSchema, IsoTimestampSchema } from "../primitives.js";
import { INITIAL_SCHEMA_VERSION } from "../schema-version.js";
import { defineEventContract } from "./event-contract.js";

/** A sha256 digest as 64 lowercase hexadecimal characters. */
export const SeriesConfigHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "must be a sha256 digest: 64 lowercase hexadecimal characters");

export const SeriesWindowAdmittedPayloadSchema = z.strictObject({
  internalMarketId: InternalMarketIdSchema,
  conditionId: ConditionIdSchema,
  /** The reviewed series' configuration key, e.g. `btc-15m-updown` (§9.2). */
  seriesId: CodeStringSchema,
  /** sha256 of the reviewed series document the window was judged against. */
  seriesConfigHash: SeriesConfigHashSchema,
  yesTokenId: TokenIdSchema,
  noTokenId: TokenIdSchema,
  /** The window's scheduled open, derived from its title (ruling Q3). */
  scheduledOpenAt: IsoTimestampSchema,
  /** The window's scheduled close, derived from its title (ruling Q3). */
  scheduledCloseAt: IsoTimestampSchema,
  /** The window's tick size at admission: per-window data (ruling Q3). */
  tickSize: PositiveDecimalStringSchema,
  /** The venue's title for the window, verbatim: the schedule's authority. */
  windowTitle: DetailStringSchema,
});

export const SeriesWindowAdmittedContract = defineEventContract(
  "SeriesWindowAdmitted",
  INITIAL_SCHEMA_VERSION,
  SeriesWindowAdmittedPayloadSchema,
);

export const SERIES_ADMISSION_CONTRACTS = [SeriesWindowAdmittedContract] as const;

export type SeriesWindowAdmittedPayload = z.infer<typeof SeriesWindowAdmittedPayloadSchema>;
