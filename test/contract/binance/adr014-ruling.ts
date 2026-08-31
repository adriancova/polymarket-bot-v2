/**
 * Span-scoped parser for ADR-014 §3's Binance mapping row.
 *
 * WHY THIS EXISTS (FU1 remediation round 1, finding M1). ADR-014 states the
 * Binance `m` mapping more than once: §3's table row is the normative
 * statement, and the same wording recurs in §7's conformance-verdict table and
 * in §7's follow-up list, as history. The previous parser searched the ENTIRE
 * document for the first `m = true → …` string, so when the review probed the
 * real §3 row — rewording it, or merely changing its whitespace — the suite
 * stayed green by silently falling through to those later duplicates. That
 * contradicted the suite's own claim to "refuse to run at all if the record's
 * ruling text is not where it says it is."
 *
 * The parser therefore now:
 *
 *   1. isolates the text between the `### 3` and `### 4` headings, requiring
 *      exactly one of each, in that order;
 *   2. requires EXACTLY ONE row (line) in that span stating BOTH boolean arms
 *      of the mapping; and
 *   3. requires EXACTLY ONE side per arm within that row.
 *
 * Anything else throws `Adr014ParseError`, failing every dependent test
 * loudly. Harmless whitespace variation WITHIN the row stays accepted — the
 * arm pattern is whitespace-tolerant — but removing, rewording, duplicating,
 * or moving the row out of §3 refuses, no matter what the rest of the
 * document says. `adr014-ruling.test.ts` pins each of those refusals as a
 * permanent mutation probe.
 *
 * OFFLINE and read-only: this module is given text and returns text; it never
 * touches the filesystem itself.
 */

/** Loud, typed refusal: the ruling text is not where — or what — it must be. */
export class Adr014ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Adr014ParseError";
  }
}

/** Start offsets of every line-anchored `### <ordinal>` heading. */
function headingStarts(adr: string, ordinal: 3 | 4): readonly number[] {
  const pattern = new RegExp(String.raw`^### ${String(ordinal)}[.\s]`, "gmu");
  return [...adr.matchAll(pattern)].map((match) => match.index);
}

/**
 * The §3 span: from the `### 3` heading up to, and not including, the `### 4`
 * heading. Exactly one of each heading must exist, and `### 4` must follow.
 */
export function section3Of(adr: string): string {
  const starts = headingStarts(adr, 3);
  const start = starts[0];
  if (starts.length !== 1 || start === undefined) {
    throw new Adr014ParseError(
      `ADR-014 must carry exactly one "### 3" heading opening the mapping section; found ${String(starts.length)}`,
    );
  }
  const ends = headingStarts(adr, 4);
  const end = ends[0];
  if (ends.length !== 1 || end === undefined) {
    throw new Adr014ParseError(
      `ADR-014 must carry exactly one "### 4" heading closing the §3 span; found ${String(ends.length)}`,
    );
  }
  if (end <= start) {
    throw new Adr014ParseError(
      'ADR-014\'s "### 4" heading must follow its "### 3" heading; the §3 span is unreadable',
    );
  }
  return adr.slice(start, end);
}

/**
 * One arm of the Binance row: `m = <flag> → <side>`, tolerating whitespace
 * variation between the tokens but nothing else — a reworded arm (a different
 * arrow, a paraphrase, a different flag spelling) does not match, on purpose.
 */
function armPattern(buyerIsMaker: boolean): RegExp {
  return new RegExp(String.raw`m\s*=\s*${String(buyerIsMaker)}\s*→\s*(BID|ASK)\b`, "gu");
}

/**
 * The single line inside the §3 span stating BOTH boolean arms. Zero such
 * lines (row removed, reworded, or moved elsewhere) and two or more (a
 * duplicate inside §3) both refuse: a test must never have to guess which
 * statement of the mapping is normative.
 */
export function binanceRowOf(section3: string): string {
  const rows = section3
    .split("\n")
    .filter((line) => armPattern(true).test(line) && armPattern(false).test(line));
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Adr014ParseError(
      `ADR-014 §3 must state the Binance mapping — both arms of \`m\` — on exactly one row between the "### 3" and "### 4" headings; found ${String(rows.length)} such rows. A duplicate of the wording elsewhere in the document does not count.`,
    );
  }
  return row;
}

/** The ruled side for one `m` value, read from the row, exactly once. */
function ruledSideInRow(row: string, buyerIsMaker: boolean): "BID" | "ASK" {
  const matches = [...row.matchAll(armPattern(buyerIsMaker))];
  const side = matches[0]?.[1];
  if (matches.length !== 1 || (side !== "BID" && side !== "ASK")) {
    throw new Adr014ParseError(
      `ADR-014 §3's Binance row must state the side for m = ${String(buyerIsMaker)} exactly once; found ${String(matches.length)} arms in the row`,
    );
  }
  return side;
}

/**
 * §3's Binance mapping, parsed from the full ruling text: the side ADR-014
 * rules for one value of the venue's documented `m` ("Is the buyer the market
 * maker?"). This — and only this — is how the conformance suite reads the
 * expected `takerSide`.
 *
 * BOTH arms are validated before EITHER is returned: a row that is incoherent
 * for one `m` value (say, two contradictory `m = true` arms) is refused for
 * both queries, so no test reads half of a broken row and passes.
 */
export function ruledSideForBinanceFlagIn(adr: string, buyerIsMaker: boolean): "BID" | "ASK" {
  const row = binanceRowOf(section3Of(adr));
  const whenBuyerIsMaker = ruledSideInRow(row, true);
  const whenBuyerIsTaker = ruledSideInRow(row, false);
  return buyerIsMaker ? whenBuyerIsMaker : whenBuyerIsTaker;
}
