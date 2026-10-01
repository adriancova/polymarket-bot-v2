/**
 * The research tier's columnar layout (`STORAGE-1`; ADR-028 Decision 1.3,
 * ADR-029; `docs/handoffs/LEAN-1.md` §4).
 *
 * The research tier is a downsampled, **approximate** record kept forever. It
 * is not a second copy of the raw WAL: it cannot show queue position or moves
 * inside one second (ADR-028 Decision 7), and a dataset built from it is never
 * admissible as determinism, calibration, promotion or soak evidence (ADR-029
 * Decision 2). This module pins *what its objects look like*; the rules that
 * decide *which* samples exist and *when each is released* belong to the
 * downsampler that produces them (`apps/research-worker`), whose version every
 * research-tier manifest pins.
 *
 * ## Every row is a sample with a release frame
 *
 * ADR-029 Decision 5: order comes from the recorded dispatch order, never from
 * instants. Every row therefore starts with the same five columns:
 *
 * | Column | Meaning |
 * | --- | --- |
 * | `sampleOrdinal` | Dense consumption order within the dataset. Assigned in the release frames' dispatch order, ties broken by the downsampling version's fixed order (Decision 5.3) |
 * | `gatewayEpoch` | The release frame's epoch (Decision 5.2). A dataset covers one epoch (5.4) |
 * | `releaseIngestSeq` | The release frame's `ingestSeq` (5.2): the frame at which a live process would hold all of the sample's information |
 * | `availableAt` | The release frame's receipt instant, as recorded (5.2). Event time for an approximate replay; **never** used to order samples |
 * | `releaseSegmentId` | The WAL segment holding the release frame (provenance) |
 *
 * ## Encoding, as for the raw-frame layout
 *
 * Every decimal value is a **canonical decimal string** (`BYTE_ARRAY` +
 * `UTF8`), never a Parquet `DECIMAL` or a float — the reasoning in
 * `parquet-layout.ts` applies unchanged (handoff §7.3, ADR-001). `ingestSeq`
 * stays a string for the same 40-digit reason. Integral positions this package
 * computes (`sampleOrdinal`, span bounds in epoch milliseconds, counts) are
 * `INT64`, which represents every safe integer exactly.
 *
 * Changing any table, column, type, order or meaning is a
 * {@link RESEARCH_TIER_LAYOUT_VERSION} bump; a research-tier manifest pins the
 * layout id, its version, and every table's column list.
 */

/** Identity of the research-tier layout. Pinned by every research-tier manifest. */
export const RESEARCH_TIER_LAYOUT_ID = "polymarket-bot/research-tier/v1";

/** Version of {@link RESEARCH_TIER_LAYOUT_ID}. */
export const RESEARCH_TIER_LAYOUT_VERSION = 1;

/** Physical type of one research-tier column. */
export type ResearchColumnPhysicalType = "BYTE_ARRAY_UTF8" | "INT64" | "BOOLEAN";

/** The pinned description of one research-tier column. */
export type ResearchColumnSpec = {
  readonly name: string;
  readonly physicalType: ResearchColumnPhysicalType;
  readonly nullable: boolean;
  readonly description: string;
};

/**
 * The research-tier tables, in their fixed **kind order** (ADR-029 Decision
 * 5.3: "Several samples released at one frame are consumed in a fixed order
 * that the downsampling version defines, for example by sample kind").
 */
export const RESEARCH_TABLE_NAMES = [
  "pm_top_of_book",
  "pm_depth",
  "pm_full_book",
  "ref_trade_bars",
  "feed_events",
  "pm_lifecycle",
  "pm_trades",
  "chainlink_ticks",
] as const;

/** One research-tier table. */
export type ResearchTableName = (typeof RESEARCH_TABLE_NAMES)[number];

/**
 * Whether a table holds span samples (released at the first frame at or after
 * the span's boundary) or on-change samples (released at their last
 * contributing frame). ADR-029 Decision 5.1.
 */
export type ResearchSampleClass = "span" | "on-change";

/** The number of book levels per side `pm_depth` carries. */
export const RESEARCH_DEPTH_LEVELS = 5;

const STRING = "BYTE_ARRAY_UTF8" as const;
const INT64 = "INT64" as const;
const BOOLEAN = "BOOLEAN" as const;

function column(
  name: string,
  physicalType: ResearchColumnPhysicalType,
  nullable: boolean,
  description: string,
): ResearchColumnSpec {
  return { name, physicalType, nullable, description };
}

/** The five release columns every research-tier row starts with. */
export const RESEARCH_RELEASE_COLUMNS: readonly ResearchColumnSpec[] = [
  column("sampleOrdinal", INT64, false, "Dense consumption order within the dataset (ADR-029 Decision 5.3)."),
  column("gatewayEpoch", STRING, false, "The release frame's gateway epoch (ADR-029 Decision 5.2)."),
  column(
    "releaseIngestSeq",
    STRING,
    false,
    "The release frame's ingestSeq, a canonical unsigned integer string of up to 40 digits.",
  ),
  column(
    "availableAt",
    STRING,
    false,
    "The release frame's receipt instant as recorded. Event time; never an ordering key.",
  ),
  column("releaseSegmentId", STRING, false, "The WAL segment that holds the release frame."),
];

const SPAN_COLUMNS: readonly ResearchColumnSpec[] = [
  column("spanStartMs", INT64, false, "Start of the summarized span, epoch milliseconds (inclusive)."),
  column("spanEndMs", INT64, false, "End of the summarized span, epoch milliseconds (its boundary)."),
];

const TOKEN_COLUMNS: readonly ResearchColumnSpec[] = [
  column("conditionId", STRING, false, "Polymarket condition id (the market)."),
  column("tokenId", STRING, false, "Polymarket outcome token id (asset_id)."),
];

function depthColumns(): readonly ResearchColumnSpec[] {
  const columns: ResearchColumnSpec[] = [];
  for (const side of ["bid", "ask"] as const) {
    for (let level = 1; level <= RESEARCH_DEPTH_LEVELS; level += 1) {
      columns.push(
        column(`${side}${String(level)}Price`, STRING, true, `Level ${String(level)} ${side} price; null when the side has fewer levels.`),
        column(`${side}${String(level)}Size`, STRING, true, `Level ${String(level)} ${side} size; null when the side has fewer levels.`),
      );
    }
  }
  return columns;
}

/** One table's pinned definition. */
export type ResearchTableSpec = {
  readonly name: ResearchTableName;
  readonly sampleClass: ResearchSampleClass;
  readonly columns: readonly ResearchColumnSpec[];
};

/** Every research-tier table, in kind order. The single layout authority. */
export const RESEARCH_TABLES: readonly ResearchTableSpec[] = [
  {
    name: "pm_top_of_book",
    sampleClass: "span",
    columns: [
      ...RESEARCH_RELEASE_COLUMNS,
      ...SPAN_COLUMNS,
      ...TOKEN_COLUMNS,
      column("bestBidPrice", STRING, true, "Best bid at the span's close; null when the bid side is empty."),
      column("bestBidSize", STRING, true, "Size at the best bid."),
      column("bestAskPrice", STRING, true, "Best ask at the span's close; null when the ask side is empty."),
      column("bestAskSize", STRING, true, "Size at the best ask."),
    ],
  },
  {
    name: "pm_depth",
    sampleClass: "span",
    columns: [...RESEARCH_RELEASE_COLUMNS, ...SPAN_COLUMNS, ...TOKEN_COLUMNS, ...depthColumns()],
  },
  {
    name: "pm_full_book",
    sampleClass: "span",
    columns: [
      ...RESEARCH_RELEASE_COLUMNS,
      ...SPAN_COLUMNS,
      ...TOKEN_COLUMNS,
      column("bidLevelCount", INT64, false, "Number of bid levels in the book."),
      column("askLevelCount", INT64, false, "Number of ask levels in the book."),
      column("bidsJson", STRING, false, 'Bid levels best first, canonical JSON [["price","size"],...].'),
      column("asksJson", STRING, false, 'Ask levels best first, canonical JSON [["price","size"],...].'),
    ],
  },
  {
    name: "ref_trade_bars",
    sampleClass: "span",
    columns: [
      ...RESEARCH_RELEASE_COLUMNS,
      ...SPAN_COLUMNS,
      column("source", STRING, false, "Reference venue (binance or coinbase)."),
      column("instrument", STRING, false, "Symbol or product id, verbatim from the venue."),
      column("open", STRING, false, "First trade price in the span, in dispatch order."),
      column("high", STRING, false, "Highest trade price in the span."),
      column("low", STRING, false, "Lowest trade price in the span."),
      column("close", STRING, false, "Last trade price in the span, in dispatch order."),
      column("volume", STRING, false, "Exact decimal sum of the trade sizes."),
      column("tradeCount", INT64, false, "Number of trades in the span."),
    ],
  },
  {
    name: "feed_events",
    sampleClass: "on-change",
    columns: [
      ...RESEARCH_RELEASE_COLUMNS,
      column("source", STRING, false, "Feed source label, verbatim from the raw record."),
      column("endpoint", STRING, false, "Endpoint, verbatim from the raw record."),
      column("connectionId", STRING, false, "Connection identity, verbatim from the raw record."),
      column("subscriptionGeneration", INT64, false, "Subscription generation, verbatim from the raw record."),
      column("eventKind", STRING, false, "connection-changed | uninterpretable | snapshot-trades-excluded."),
      column("detail", STRING, false, "Bounded human-readable detail."),
      column("payloadSha256", STRING, false, "The raw frame's payload digest."),
    ],
  },
  {
    name: "pm_lifecycle",
    sampleClass: "on-change",
    columns: [
      ...RESEARCH_RELEASE_COLUMNS,
      column("source", STRING, false, "Feed source label, verbatim from the raw record."),
      column("endpoint", STRING, false, "Endpoint, verbatim from the raw record."),
      column("eventType", STRING, false, "gamma-market | tick_size_change | new_market | market_resolved."),
      column("entryIndex", INT64, false, "Position of the event inside its frame."),
      column("conditionId", STRING, true, "Condition id, when the event names one."),
      column("tokenId", STRING, true, "Token id, when the event names one."),
      column("active", BOOLEAN, true, "Gamma `active`, a documented state field."),
      column("closed", BOOLEAN, true, "Gamma `closed`, a documented state field."),
      column("acceptingOrders", BOOLEAN, true, "Gamma `acceptingOrders`, a documented state field."),
      column("archived", BOOLEAN, true, "Gamma `archived`, a documented state field."),
      column("restricted", BOOLEAN, true, "Gamma `restricted`, a documented state field."),
      column("detailJson", STRING, true, "Event-specific values, canonical JSON (tick sizes, winning asset)."),
      column("payloadSha256", STRING, false, "The raw frame's payload digest."),
    ],
  },
  {
    name: "pm_trades",
    sampleClass: "on-change",
    columns: [
      ...RESEARCH_RELEASE_COLUMNS,
      ...TOKEN_COLUMNS,
      column("entryIndex", INT64, false, "Position of the event inside its frame."),
      column("price", STRING, false, "Trade price, canonical decimal."),
      column("size", STRING, true, "Trade size, canonical decimal, when the venue sent one."),
      column("side", STRING, false, "Taker side as the venue documents it (BUY or SELL)."),
      column("feeRateBps", STRING, true, "Fee rate in basis points, when the venue sent one."),
      column("venueTimestamp", STRING, true, "The venue's own timestamp, verbatim. Carried, never used to order."),
      column("transactionHash", STRING, true, "Transaction hash, when the venue sent one."),
    ],
  },
  {
    name: "chainlink_ticks",
    sampleClass: "on-change",
    columns: [
      ...RESEARCH_RELEASE_COLUMNS,
      column("topic", STRING, false, "RTDS topic, verbatim."),
      column("symbol", STRING, false, "Symbol, verbatim."),
      column("entryIndex", INT64, false, "Position of the observation inside its frame."),
      column("value", STRING, false, "Observed value at full accuracy, canonical decimal."),
      column("observedAt", STRING, true, "The venue's observation instant, verbatim. Carried, never used to order."),
    ],
  },
];

/** Look up a table's definition. Throws on an unknown table name. */
export function researchTableSpec(name: string): ResearchTableSpec {
  const spec = RESEARCH_TABLES.find((table) => table.name === name);
  if (spec === undefined) {
    throw new Error(`unknown research-tier table ${JSON.stringify(name)}`);
  }
  return spec;
}

/** One research-tier row: every column of its table, by name. */
export type ResearchRow = Readonly<Record<string, string | number | boolean | null>>;
