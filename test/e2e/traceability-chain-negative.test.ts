/**
 * The chain walk, MUTATION-TESTED against itself.
 *
 * A verification whose only evidence is "the assertion passed" proves nothing
 * about the assertion. This file breaks the golden document ONE LINK AT A TIME
 * and requires the walk to report THAT hop — by name — as the broken one. A hop
 * whose mutation still passes is a hop nothing checks, and the test says which.
 *
 * Every mutation is applied to a DEEP COPY of the committed golden, so the file
 * on disk is never touched and the mutations cannot leak between cases.
 *
 * The document-level integrity checks (orphans, duplicates, dangling
 * references, non-PAPER bookings) get the same treatment at the bottom of the
 * file: each is provoked by a mutation and matched by its finding code. The
 * `orderProvenance` section (`RECON-2`) is last, asserted by EXACT finding set.
 */

import { describe, expect, it } from "vitest";

import { explainWalk, walkChains, type Hop, type WalkableDocument } from "./support/chain-walk.js";
import { goldenBytes } from "./support/golden.js";

/** A mutable deep copy of the golden, as plain JSON. */
function mutableGolden(): Record<string, unknown> {
  return JSON.parse(goldenBytes()) as Record<string, unknown>;
}

function asDocument(value: Record<string, unknown>): WalkableDocument {
  return value as unknown as WalkableDocument;
}

function row(value: Record<string, unknown>, key: string, index: number): Record<string, unknown> {
  const list = value[key] as Record<string, unknown>[];
  const entry = list[index];
  if (entry === undefined) throw new Error(`the golden has no ${key}[${String(index)}]`);
  return entry;
}

interface HopMutation {
  readonly hop: Hop;
  readonly what: string;
  readonly mutate: (document: Record<string, unknown>) => void;
  /**
   * The EXACT set of hops the mutation must break, in hop order.
   *
   * Stated exactly rather than as "contains the target", because some hops read
   * THROUGH others by design — the feature hop compares against the persisted
   * decision, the plan hop confirms itself against the booked order — and a
   * `toContain` assertion would let a mutation that broke the entire walk pass
   * as evidence for one link. Where a mutation breaks more than one hop, the
   * coupling is named in `what`.
   */
  readonly breaks: readonly Hop[];
}

const HOP_MUTATIONS: readonly HopMutation[] = [
  {
    hop: "event",
    what:
      "the chain names a source event that was never recorded (the decision hop breaks with " +
      "it, because it re-checks the same event against the persisted record)",
    breaks: ["event", "decision"],
    mutate: (document) => {
      row(document, "traces", 0)["sourceEventId"] = "018f5c20-9000-7a90-8b00-000000009999";
    },
  },
  {
    hop: "feature",
    what: "the chain names a feature snapshot the persisted decision did not use",
    breaks: ["feature"],
    mutate: (document) => {
      row(document, "traces", 0)["featureSnapshotRef"] = "f".repeat(64);
    },
  },
  {
    hop: "decision",
    what:
      "the chain names an evaluation sequence no persisted decision has (every hop that reads " +
      "THROUGH the decision — feature, intent and the instance-scoped snapshot — breaks too)",
    breaks: ["feature", "decision", "intent", "pnl-snapshot"],
    mutate: (document) => {
      row(document, "traces", 0)["evaluationSeq"] = 9999;
    },
  },
  {
    hop: "intent",
    what: "the chain names an intent the persisted decision never emitted",
    breaks: ["intent"],
    mutate: (document) => {
      row(document, "traces", 0)["intentId"] = "sb-entry-0-not-a-real-intent";
    },
  },
  {
    hop: "approved-intent",
    what: "the approved-intent id is empty, so nothing authorised the plan",
    breaks: ["approved-intent"],
    mutate: (document) => {
      row(document, "traces", 0)["approvedIntentId"] = "";
    },
  },
  {
    hop: "plan",
    what: "the booked order was placed under a different execution plan",
    breaks: ["plan"],
    mutate: (document) => {
      row(document, "orders", 0)["executionPlanId"] = "9280f970-9280-7000-8000-00000000ffff";
    },
  },
  {
    hop: "submission",
    what: "the submission-attempt id repeats the execution-plan id",
    breaks: ["submission"],
    mutate: (document) => {
      const trace = row(document, "traces", 0);
      trace["submissionAttemptId"] = trace["executionPlanId"];
    },
  },
  {
    hop: "order",
    what:
      "the chain names a venue order that was never booked (the plan and fill hops confirm " +
      "themselves against that order, so they break with it)",
    breaks: ["plan", "order", "fill"],
    mutate: (document) => {
      row(document, "traces", 0)["venueOrderId"] = "no-such-order";
    },
  },
  {
    hop: "fill",
    what: "the fill is relabelled as real evidence, which ADR-012 §2 forbids",
    breaks: ["fill"],
    mutate: (document) => {
      row(document, "fills", 0)["evidenceClass"] = "REAL_VENUE_EVIDENCE";
    },
  },
  {
    hop: "ledger-posting",
    what: "one named posting is missing from the persisted history",
    breaks: ["ledger-posting"],
    mutate: (document) => {
      const trace = row(document, "traces", 0);
      const ids = trace["ledgerTransactionIds"] as string[];
      const dropped = ids[0];
      const list = document["ledgerTransactions"] as Record<string, unknown>[];
      document["ledgerTransactions"] = list.filter(
        (transaction) => transaction["ledgerTransactionId"] !== dropped,
      );
    },
  },
  {
    hop: "pnl-record",
    what: "no §9.16 record refers to anything the chain posted",
    breaks: ["pnl-record"],
    mutate: (document) => {
      document["pnlRecords"] = [];
    },
  },
  {
    hop: "pnl-snapshot",
    what: "the run persisted no PnL snapshot for the chain's run and instance",
    breaks: ["pnl-snapshot"],
    mutate: (document) => {
      document["pnlSnapshots"] = [];
    },
  },
];

describe("the chain walk is falsifiable, hop by hop", () => {
  it("the unmutated golden walks clean, so every failure below is the mutation's", () => {
    const report = walkChains(asDocument(mutableGolden()));
    expect(explainWalk(report)).toBe("the walk found nothing");
  });

  it("every hop in the vocabulary has a mutation aimed at it", () => {
    const covered = new Set(HOP_MUTATIONS.map((mutation) => mutation.hop));
    const report = walkChains(asDocument(mutableGolden()));
    const walked = new Set(report.chains[0]?.hops.map((result) => result.hop) ?? []);
    expect([...walked].filter((hop) => !covered.has(hop))).toEqual([]);
  });

  for (const mutation of HOP_MUTATIONS) {
    it(`hop "${mutation.hop}" breaks when ${mutation.what}`, () => {
      const document = mutableGolden();
      mutation.mutate(document);
      const report = walkChains(asDocument(document));
      expect(report.ok).toBe(false);
      expect(
        report.brokenHops,
        `the mutation should have broken exactly [${mutation.breaks.join(", ")}]. The walk ` +
          `said:\n${explainWalk(report)}`,
      ).toEqual([...mutation.breaks]);
      expect(report.brokenHops).toContain(mutation.hop);
    });
  }
});

interface FindingMutation {
  readonly code: string;
  readonly what: string;
  readonly mutate: (document: Record<string, unknown>) => void;
}

const FINDING_MUTATIONS: readonly FindingMutation[] = [
  {
    code: "ORPHAN_LEDGER_TRANSACTION",
    what: "a posting reached the store that no chain accounts for",
    mutate: (document) => {
      const list = document["ledgerTransactions"] as Record<string, unknown>[];
      const first = list[0];
      if (first === undefined) throw new Error("the golden has no ledger transactions");
      list.push({ ...first, ledgerTransactionId: "9280f970-9280-7000-8000-0000000cafe0" });
    },
  },
  {
    code: "ORPHAN_FILL",
    what: "the venue produced a fill no chain traces to a posting",
    mutate: (document) => {
      const list = document["fills"] as Record<string, unknown>[];
      const first = list[0];
      if (first === undefined) throw new Error("the golden has no fills");
      list.push({ ...first, simulatedFillId: "orphan-fill" });
    },
  },
  {
    code: "DANGLING_PNL_REF",
    what: "a PnL record refers to a transaction that is not in the history",
    mutate: (document) => {
      row(document, "pnlRecords", 0)["ref"] = "9280f970-9280-7000-8000-0000000dead0";
    },
  },
  {
    code: "DANGLING_DECISION_SOURCE_EVENT",
    what: "a persisted decision names an event that was never recorded",
    mutate: (document) => {
      const decisions = document["decisions"] as Record<string, unknown>[];
      const withEvent = decisions.find((decision) => decision["sourceEventId"] !== null);
      if (withEvent === undefined) throw new Error("no decision carries a source event");
      withEvent["sourceEventId"] = "018f5c20-9000-7a90-8b00-00000000dead";
    },
  },
  {
    code: "NON_PAPER_LEDGER_TRANSACTION",
    what: "a posting is booked in a run mode this run is not",
    mutate: (document) => {
      row(document, "ledgerTransactions", 0)["environment"] = "LIVE";
    },
  },
  {
    code: "LEDGER_TRANSACTION_CLAIMED_TWICE",
    what: "two chains claim the same posting",
    mutate: (document) => {
      const traces = document["traces"] as Record<string, unknown>[];
      const first = traces[0];
      const second = traces[1];
      if (first === undefined || second === undefined) {
        throw new Error("the golden has fewer than two chains");
      }
      second["ledgerTransactionIds"] = [...(first["ledgerTransactionIds"] as string[])];
    },
  },
  {
    code: "DECISION_KEY_NOT_UNIQUE",
    what: "two persisted decisions share (runId, evaluationSeq)",
    mutate: (document) => {
      const decisions = document["decisions"] as Record<string, unknown>[];
      const first = decisions[0];
      if (first === undefined) throw new Error("the golden has no decisions");
      decisions.push({ ...first });
    },
  },
  {
    code: "FILL_ID_NOT_UNIQUE",
    what: "the venue reports the same fill id twice",
    mutate: (document) => {
      const fills = document["fills"] as Record<string, unknown>[];
      const first = fills[0];
      if (first === undefined) throw new Error("the golden has no fills");
      fills.push({ ...first });
    },
  },
  {
    code: "NO_CHAIN",
    what: "the run produced no chain at all",
    mutate: (document) => {
      document["traces"] = [];
    },
  },
];

describe("the document-level integrity checks are falsifiable too", () => {
  for (const mutation of FINDING_MUTATIONS) {
    it(`"${mutation.code}" fires when ${mutation.what}`, () => {
      const document = mutableGolden();
      mutation.mutate(document);
      const report = walkChains(asDocument(document));
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((finding) => finding.startsWith(`${mutation.code}:`)),
        `expected a ${mutation.code} finding. The walk said:\n${explainWalk(report)}`,
      ).toBe(true);
    });
  }

  it("the walk never throws, whatever the document is missing", () => {
    for (const key of [
      "events",
      "decisions",
      "traces",
      "orderProvenance",
      "orders",
      "fills",
      "ledgerTransactions",
      "pnlRecords",
      "pnlSnapshots",
    ]) {
      const document = mutableGolden();
      document[key] = [];
      // A walker that threw would turn "the chain is broken" into "the test
      // crashed", and only one of those says where to look.
      expect(() => walkChains(asDocument(document))).not.toThrow();
    }
    // `RECON-2`: a format-1 document has no provenance section at all.
    const formatOne = mutableGolden();
    delete formatOne["orderProvenance"];
    expect(() => walkChains(asDocument(formatOne))).not.toThrow();
  });
});

/** The provenance record of the order the venue booked with `state`. */
function recordOfOrderIn(document: Record<string, unknown>, state: string): Record<string, unknown> {
  const orders = document["orders"] as Record<string, unknown>[];
  const order = orders.find((candidate) => candidate["state"] === state);
  if (order === undefined) throw new Error(`the golden has no ${state} order`);
  const records = document["orderProvenance"] as Record<string, unknown>[];
  const record = records.find(
    (candidate) => candidate["venueOrderId"] === order["simulatedOrderId"],
  );
  if (record === undefined) throw new Error(`the ${state} order has no provenance record`);
  return record;
}

/** The withdrawn take-profit's record: the one node that NO chain shares. */
function takeProfitRecord(document: Record<string, unknown>): Record<string, unknown> {
  return recordOfOrderIn(document, "CANCELLED");
}

/** The entry's record, which the entry's two chains complete. */
function entryRecord(document: Record<string, unknown>): Record<string, unknown> {
  const records = document["orderProvenance"] as Record<string, unknown>[];
  const record = records.find((candidate) => String(candidate["intentId"]).startsWith("sb-entry-"));
  if (record === undefined) throw new Error("the golden has no entry provenance record");
  return record;
}

interface ProvenanceMutation {
  readonly what: string;
  readonly mutate: (document: Record<string, unknown>) => void;
  /** The EXACT set of finding codes the mutation must produce, sorted. */
  readonly codes: readonly string[];
}

/**
 * `RECON-2`: the `orderProvenance` section, walked as NODES of the closed-world
 * graph. Each record must resolve, none may be an orphan, no booked order may be
 * without one, and a chain must agree with its order's record.
 *
 * Asserted EXACTLY — the full set of finding codes, and no broken hop — so a
 * mutation cannot pass by tripping some other check. Most mutations aim at the
 * withdrawn take-profit's record because no chain shares it: a change there is
 * visible ONLY to the provenance walk, which a trace-only walk could never see.
 */
const PROVENANCE_MUTATIONS: readonly ProvenanceMutation[] = [
  {
    what: "the withdrawn take-profit — on no chain — loses its record",
    codes: ["ORDER_WITHOUT_PROVENANCE"],
    mutate: (document) => {
      const doomed = takeProfitRecord(document);
      const records = document["orderProvenance"] as Record<string, unknown>[];
      document["orderProvenance"] = records.filter((record) => record !== doomed);
    },
  },
  {
    what: "a record names an order the venue never booked",
    codes: ["ORPHAN_PROVENANCE"],
    mutate: (document) => {
      const records = document["orderProvenance"] as Record<string, unknown>[];
      records.push({ ...takeProfitRecord(document), venueOrderId: "no-such-order:g0:o0" });
    },
  },
  {
    what: "one order carries two records",
    codes: ["PROVENANCE_ORDER_NOT_UNIQUE"],
    mutate: (document) => {
      const records = document["orderProvenance"] as Record<string, unknown>[];
      records.push({ ...takeProfitRecord(document) });
    },
  },
  {
    what: "a record names an evaluation no persisted decision has",
    codes: ["PROVENANCE_UNRESOLVED"],
    mutate: (document) => {
      takeProfitRecord(document)["evaluationSeq"] = 9999;
    },
  },
  {
    what: "a record names an intent its decision never emitted",
    codes: ["PROVENANCE_UNRESOLVED"],
    mutate: (document) => {
      takeProfitRecord(document)["intentId"] = "sb-take-profit-9-not-a-real-intent";
    },
  },
  {
    what: "a record names a feature snapshot its decision did not use",
    codes: ["PROVENANCE_UNRESOLVED"],
    mutate: (document) => {
      takeProfitRecord(document)["featureSnapshotRef"] = "f".repeat(64);
    },
  },
  {
    what: "a record names a source event where its decision names none",
    codes: ["PROVENANCE_UNRESOLVED"],
    mutate: (document) => {
      // The take-profit was placed by an `onFill` evaluation, which the loop
      // ORIGINATED: its decision has no source event and its record says "".
      takeProfitRecord(document)["sourceEventId"] = entryRecord(document)["sourceEventId"];
    },
  },
  {
    what: "a record says \"\" where its decision names a recorded event (its chains disagree too)",
    codes: ["PROVENANCE_TRACE_MISMATCH", "PROVENANCE_UNRESOLVED"],
    mutate: (document) => {
      entryRecord(document)["sourceEventId"] = "";
    },
  },
  {
    what: "a record's approved-intent id repeats its plan id",
    codes: ["PROVENANCE_UNRESOLVED"],
    mutate: (document) => {
      const record = takeProfitRecord(document);
      record["approvedIntentId"] = record["executionPlanId"];
    },
  },
  {
    what: "a record names a plan the booked order was not placed under",
    codes: ["PROVENANCE_UNRESOLVED"],
    mutate: (document) => {
      takeProfitRecord(document)["executionPlanId"] = "9280f970-9280-7000-8000-00000000ffff";
    },
  },
  {
    what: "a chain disagrees with its order's record on a field no hop reads twice",
    codes: ["PROVENANCE_TRACE_MISMATCH"],
    mutate: (document) => {
      // A distinct, non-empty approval id satisfies the chain's own
      // approved-intent and submission hops; only the record contradicts it.
      row(document, "traces", 0)["approvedIntentId"] = "9280f970-9280-7000-8000-00000000a0a0";
    },
  },
  {
    what: "the section is absent altogether (a format-1 document)",
    codes: ["ORDER_WITHOUT_PROVENANCE", "PROVENANCE_SECTION_MISSING"],
    mutate: (document) => {
      delete document["orderProvenance"];
    },
  },
];

describe("RECON-2 — every provenance record is a resolved node, and none is an orphan", () => {
  it("the unmutated golden carries one record per booked order, and they all resolve", () => {
    const document = mutableGolden();
    const records = document["orderProvenance"] as Record<string, unknown>[];
    const orders = document["orders"] as Record<string, unknown>[];
    expect(records.map((record) => record["venueOrderId"])).toEqual(
      orders.map((order) => order["simulatedOrderId"]),
    );
    expect(walkChains(asDocument(document)).findings).toEqual([]);
  });

  for (const mutation of PROVENANCE_MUTATIONS) {
    it(`${mutation.codes.join(" + ")} — and nothing else — when ${mutation.what}`, () => {
      const document = mutableGolden();
      mutation.mutate(document);
      const report = walkChains(asDocument(document));
      expect(report.ok).toBe(false);
      const codes = [
        ...new Set(report.findings.map((finding) => finding.split(":")[0] ?? "")),
      ].sort();
      expect(codes, explainWalk(report)).toEqual([...mutation.codes]);
      expect(report.brokenHops, explainWalk(report)).toEqual([]);
    });
  }
});
