/**
 * `packages/pnl` — the ADR-020 §3 door, measured.
 *
 * WHERE THIS FILE LIVES, AND WHY. `WP-200` put the PnL package's unit tests
 * beside their sources (`packages/pnl/src/*.test.ts`) and its CROSS-package and
 * contract-level PnL tests in `test/unit/ledger/`
 * (`ledger-to-pnl-contract.test.ts`, `purity-and-safety.test.ts`, which exercises
 * both packages). This battery is contract-level and shares the harness with
 * the ledger battery next to it, so it follows the second convention. The
 * package-local half — the cold-lazy regression, which needs a FRESH module
 * registry — is at `packages/pnl/src/schema-boundary.test.ts`.
 *
 * THE §3 ROW THIS CLOSES: `packages/pnl` (`WP-200`), caller exposure, verdict
 * **LIVE**, severity **HIGH**, owner `WP-200-FU1` — "same classes; additionally
 * the discriminated union throws an escaped `TypeError` on a cold first parse
 * under enumerable pollution and is then permanently poisoned".
 *
 * THE BASE TRANSCRIPT (`/dev/shm/wp200fu1-base` = `main` `761db76`, probes Q
 * and R):
 *
 * ```text
 * Q1  clean, TRADE missing price:       {"ok":false,"codes":["PNL_INPUT_INVALID"]}
 * Q2  NE inherited price:               {"ok":true,"lots":{"TOK":{"shares":"10","costBasis":"9.9"}}}
 * Q3  clean, garbage ref + timestamps:  {"ok":false,"codes":["PNL_INPUT_INVALID"]}
 * Q4  NE inherited skipChecks:          {"ok":true,"refs":["totally-not-a-uuid"]}
 * Q5  clean, snapshot missing asOf:     {"ok":false,"codes":["PNL_INPUT_INVALID"]}
 * Q6  NE inherited asOf:                {"ok":true,"rows":[{"asOf":"2026-01-01T00:00:00Z", …}]}
 * Q7  clean, booking missing env:       {"ok":false,"codes":["PNL_INPUT_INVALID"]}
 * Q8  NE inherited environment:         {"ok":true,"size":1}
 * Q9  clean, identity missing account:  THREW PnlConfigurationError
 * Q10 NE inherited accountRef:          ACCEPTED accountRef=acct-from-prototype
 * R2  cold first parse, ENUMERABLE zzUnrelated:
 *       ESCAPED TypeError: Cannot read properties of undefined (reading 'values')
 * R3  the same call afterwards, prototype CLEAN:
 *       ESCAPED Error: Invalid discriminated union option at index "0"   ← POISONED
 * ```
 *
 * THE BOUND (ADR-020 §6): permission never varies, the monetary outcome of a
 * clean input is byte-identical, and no throw escapes. The one allowed
 * variation is the fail-CLOSED array-index class disclosed in
 * `schema-boundary.test.ts` next to this file.
 *
 * EVIDENCE CLASSES: every assertion is EXECUTED against the shipped sources.
 */

import { describe, expect, it } from "vitest";

import {
  PnlRecordSchema,
  PnlSettlementEvidence,
  applyPnlRecord,
  computePnlSnapshot,
  emptyPnlState,
  foldPnlRecords,
  serializePnlState,
  toPnlSnapshotRow,
} from "../../../packages/pnl/src/index.js";
import {
  DESCRIPTOR_ATTRIBUTE_NAMES,
  ZOD_PARSE_STATE_NAMES,
  candidateKeys,
  canonical,
  describeResult,
  render,
  sweep,
  sweepRequiredKeyWaiver,
  type Divergence,
  type Scenario,
} from "./pollution.js";

const REF_A = "01936f00-0000-7000-8000-000000000101";
const REF_B = "01936f00-0000-7000-8000-000000000102";
const REF_C = "01936f00-0000-7000-8000-000000000103";
const MARKET = "01936f00-0000-7000-8000-000000000104";
const LEDGER_TX = "01936f00-0000-7000-8000-000000000105";

const IDENTITY = {
  scope: "ACTUAL_ACCOUNT",
  environment: "PAPER",
  accountRef: "acct-1",
} as const;

const OWNER = { scope: "ACTUAL_ACCOUNT", accountRef: "acct-1" } as const;

const TRADE = {
  kind: "TRADE",
  ref: REF_A,
  owner: OWNER,
  marketId: MARKET,
  tokenAssetId: "YES-TOKEN",
  denominationAsset: "pUSD",
  side: "BUY",
  shares: "10",
  price: "0.4",
} as const;

const FEE = {
  kind: "FEE",
  ref: REF_B,
  owner: OWNER,
  denominationAsset: "pUSD",
  amount: "0.07",
  scheduleVersionRef: "fees-2026-09-01",
} as const;

const ESTIMATE_GARBAGE = {
  kind: "REWARD_ESTIMATE",
  ref: "totally-not-a-uuid",
  owner: OWNER,
  programType: "MAKER_REBATE",
  amount: "1",
  denominationAsset: "pUSD",
  methodology: "M1",
  periodStart: "yesterday-ish",
  periodEnd: "tomorrow-ish",
  computedAt: "some-time",
} as const;

const REWARD_BOOKING = {
  ledgerTransactionId: LEDGER_TX,
  eventType: "MAKER_REBATE_PAYOUT",
  environment: "PAPER",
  accountRef: "acct-1",
  source: "internal",
  occurredAt: "2026-09-04T00:00:00Z",
  entries: [
    {
      scope: "REWARD_INCOME",
      accountRef: "revenue-rewards",
      assetId: "pUSD",
      assetKind: "COLLATERAL",
      amount: "-5",
    },
    {
      scope: "ACTUAL_ACCOUNT",
      accountRef: "acct-1",
      assetId: "pUSD",
      assetKind: "COLLATERAL",
      amount: "5",
    },
  ],
} as const;

const REWARD_PAYOUT = {
  kind: "REWARD_PAYOUT",
  ref: REF_C,
  owner: OWNER,
  programType: "MAKER_REBATE",
  amount: "5",
  denominationAsset: "pUSD",
  ledgerTransactionId: LEDGER_TX,
} as const;

const SNAPSHOT_INPUT = {
  asOf: "2026-09-04T12:00:00Z",
  marks: { "YES-TOKEN": { midpoint: "0.5" } },
} as const;

/** The empty state, built ONCE while the prototype is clean. */
const EMPTY = emptyPnlState(IDENTITY);
const EVIDENCE = PnlSettlementEvidence.from([REWARD_BOOKING]);
if (!EVIDENCE.ok) throw new Error("fixture evidence refused");

function withInherited<T>(property: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, property, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  try {
    return body();
  } finally {
    delete (Object.prototype as Record<string, unknown>)[property];
  }
}

function withEnumerableInherited<T>(property: string, value: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, property, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  try {
    return body();
  } finally {
    delete (Object.prototype as Record<string, unknown>)[property];
  }
}

describe("schema-boundary §3 `packages/pnl`: the LIVE row, closed", () => {
  it("a TRADE with no own `price` is refused under an inherited one (base: costBasis 9.9)", () => {
    const noPrice: Record<string, unknown> = { ...TRADE };
    delete noPrice["price"];
    const clean = describeResult(applyPnlRecord(EMPTY, noPrice));
    const polluted = withInherited("price", "0.99", () =>
      describeResult(applyPnlRecord(EMPTY, noPrice)),
    );
    expect(clean).toBe("REFUSED PNL_INPUT_INVALID");
    expect(polluted).toBe(clean);
  });

  it("an inherited `skipChecks` no longer admits a garbage ref and three garbage timestamps", () => {
    const clean = describeResult(applyPnlRecord(EMPTY, ESTIMATE_GARBAGE));
    const polluted = withInherited("skipChecks", true, () =>
      describeResult(applyPnlRecord(EMPTY, ESTIMATE_GARBAGE)),
    );
    expect(clean).toBe("REFUSED PNL_INPUT_INVALID");
    expect(polluted).toBe(clean);
  });

  it("a snapshot input with no own `asOf` cannot be stamped from the prototype (base: it was)", () => {
    const folded = applyPnlRecord(EMPTY, TRADE);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    const noAsOf = { marks: { "YES-TOKEN": { midpoint: "0.5" } } };
    const clean = describeResult(computePnlSnapshot(folded.value, noAsOf));
    const polluted = withInherited("asOf", "2026-01-01T00:00:00Z", () =>
      describeResult(computePnlSnapshot(folded.value, noAsOf)),
    );
    expect(clean).toBe("REFUSED PNL_INPUT_INVALID");
    expect(polluted).toBe(clean);
  });

  it("a booking with no own `environment` cannot enter the evidence set (§10.8 separation)", () => {
    const noEnvironment: Record<string, unknown> = { ...REWARD_BOOKING };
    delete noEnvironment["environment"];
    const clean = PnlSettlementEvidence.from([noEnvironment]);
    const polluted = withInherited("environment", "PAPER", () =>
      PnlSettlementEvidence.from([noEnvironment]),
    );
    expect(clean.ok).toBe(false);
    expect(polluted.ok).toBe(false);
  });

  it("a stream identity with no own `accountRef` still throws (base: it OPENED on a fabricated account)", () => {
    const noAccount = { scope: "ACTUAL_ACCOUNT", environment: "PAPER" };
    expect(() => emptyPnlState(noAccount as never)).toThrow();
    const polluted = withInherited("accountRef", "acct-from-prototype", () => {
      try {
        return `OPENED ${emptyPnlState(noAccount as never).identity.accountRef}`;
      } catch {
        return "THREW";
      }
    });
    expect(polluted).toBe("THREW");
  });

  it("MUTATION KILL: the RAW record union still adopts, so the probes measure the DOOR", () => {
    const noPrice: Record<string, unknown> = { ...TRADE };
    delete noPrice["price"];
    const rawClean = PnlRecordSchema.safeParse(noPrice).success;
    const rawPolluted = withInherited("price", "0.99", () => {
      const parsed = PnlRecordSchema.safeParse(noPrice);
      return parsed.success ? (parsed.data as { price?: string }).price : undefined;
    });
    expect(rawClean).toBe(false);
    expect(rawPolluted).toBe("0.99");
  });
});

describe("the reward-payout path: an OBSERVED payout, under pollution", () => {
  it("realizes exactly once, and the same 5 pUSD, whatever is on Object.prototype", () => {
    const realize = (): string => {
      const result = applyPnlRecord(EMPTY, REWARD_PAYOUT, EVIDENCE.value);
      return result.ok
        ? `OK ${canonical(result.value.realizedRewards)}`
        : `REFUSED ${result.refusals.map((refusal) => refusal.code).join(",")}`;
    };
    const clean = realize();
    expect(clean).toContain('"pUSD"');
    expect(clean).toContain('"5"');
    for (const [property, value] of [
      ["amount", "999"],
      ["skipChecks", true],
      ["when", () => false],
      ["ledgerTransactionId", LEDGER_TX],
      ["instanceId", REF_A],
    ] as const) {
      expect(withInherited(property, value, realize)).toBe(clean);
    }
    expect(withEnumerableInherited("zzUnrelated", 1, realize)).toBe(clean);
  });

  it("an UNPROVEN payout stays unproven under every attempt to supply its evidence", () => {
    const unproven = (): string => describeResult(applyPnlRecord(EMPTY, REWARD_PAYOUT));
    const clean = unproven();
    expect(clean).toBe("REFUSED PNL_REWARD_EVIDENCE_MISSING");
    for (const property of ["evidence", "ledgerTransactionId", "skipChecks", "when", "amount"]) {
      expect(withInherited(property, true, unproven)).toBe(clean);
    }
  });
});

// ---------------------------------------------------------------------------
// The full measured-class battery
// ---------------------------------------------------------------------------

/**
 * The honest fold: two records, then the §9.16 snapshot, serialized.
 *
 * `foldPnlRecords` opens the stream with `emptyPnlState`, whose refusal channel
 * is a documented THROW (`PnlConfigurationError`) rather than a result — so for
 * THIS door a typed throw is a refusal, not an escape, and the scenario says so
 * explicitly rather than letting the harness read it as an `ESCAPE`.
 */
function honestFold(): string {
  let folded: ReturnType<typeof foldPnlRecords>;
  try {
    folded = foldPnlRecords(IDENTITY, [TRADE, FEE]);
  } catch {
    return "REFUSED PnlConfigurationError";
  }
  if (!folded.ok) return `REFUSED fold:${folded.refusals.map((r) => r.code).join(",")}`;
  const snapshot = computePnlSnapshot(folded.value, SNAPSHOT_INPUT);
  if (!snapshot.ok) return `REFUSED snapshot:${snapshot.refusals.map((r) => r.code).join(",")}`;
  const rows = snapshot.value.map((one) => toPnlSnapshotRow(one));
  return `OK ${serializePnlState(folded.value)}|${canonical(rows)}`;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "applyPnlRecord(valid TRADE)",
    run: () => describeResult(applyPnlRecord(EMPTY, TRADE)),
  },
  {
    name: "foldPnlRecords(valid stream)",
    run: () => {
      try {
        return describeResult(foldPnlRecords(IDENTITY, [TRADE, FEE]));
      } catch {
        return "REFUSED PnlConfigurationError";
      }
    },
  },
  {
    name: "applyPnlRecord(TRADE with no price)",
    run: () => {
      const noPrice: Record<string, unknown> = { ...TRADE };
      delete noPrice["price"];
      return describeResult(applyPnlRecord(EMPTY, noPrice));
    },
  },
  {
    name: "applyPnlRecord(garbage REWARD_ESTIMATE)",
    run: () => describeResult(applyPnlRecord(EMPTY, ESTIMATE_GARBAGE)),
  },
  {
    name: "applyPnlRecord(REWARD_PAYOUT with evidence)",
    run: () => describeResult(applyPnlRecord(EMPTY, REWARD_PAYOUT, EVIDENCE.value)),
  },
  {
    name: "applyPnlRecord(REWARD_PAYOUT with NO evidence)",
    run: () => describeResult(applyPnlRecord(EMPTY, REWARD_PAYOUT)),
  },
  {
    name: "PnlSettlementEvidence.from(valid booking)",
    run: () => {
      const built = PnlSettlementEvidence.from([REWARD_BOOKING]);
      return built.ok ? `OK size=${built.value.size}` : `REFUSED ${built.refusals[0]?.code ?? ""}`;
    },
  },
  {
    name: "PnlSettlementEvidence.from(booking with no environment)",
    run: () => {
      const noEnvironment: Record<string, unknown> = { ...REWARD_BOOKING };
      delete noEnvironment["environment"];
      const built = PnlSettlementEvidence.from([noEnvironment]);
      return built.ok ? `OK size=${built.value.size}` : `REFUSED ${built.refusals[0]?.code ?? ""}`;
    },
  },
  {
    name: "emptyPnlState(valid identity)",
    run: () => {
      try {
        return `OK ${canonical(emptyPnlState(IDENTITY).identity)}`;
      } catch {
        // `emptyPnlState` answers a malformed identity with a documented THROW,
        // so for THIS door the throw is the refusal channel, not an escape.
        return "REFUSED PnlConfigurationError";
      }
    },
  },
  {
    name: "emptyPnlState(identity with no accountRef)",
    run: () => {
      try {
        const opened = emptyPnlState({ scope: "ACTUAL_ACCOUNT", environment: "PAPER" } as never);
        return `OK ${canonical(opened.identity)}`;
      } catch {
        return "REFUSED PnlConfigurationError";
      }
    },
  },
  { name: "the honest fold → snapshot → row", run: honestFold },
];

const KEY_MATERIAL: readonly string[] = candidateKeys(
  {
    trade: TRADE,
    fee: FEE,
    estimate: ESTIMATE_GARBAGE,
    payout: REWARD_PAYOUT,
    booking: REWARD_BOOKING,
    snapshot: SNAPSHOT_INPUT,
    identity: IDENTITY,
  },
  [
    ...ZOD_PARSE_STATE_NAMES,
    ...DESCRIPTOR_ATTRIBUTE_NAMES,
    "zzUnrelated",
    "reservedCapital",
    "model",
    "liquidation",
    "instanceId",
    "runId",
    "settlementState",
    "reversesRef",
    "costBasis",
    // `WP-200-FU1` review round 1, finding M2. `candidateKeys` derives an index
    // name only when one is a string VALUE of an input, so this battery swept
    // `"10"` and never `"0"` — the index an accumulator reaches FIRST and the
    // only one under which `emptyPnlState` refuses a legitimate identity. Its
    // sibling battery carries the same name for the same reason.
    "0",
  ],
);

/** See `schema-boundary.test.ts`: the one disclosed fail-closed class. */
function isArrayIndexName(property: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(property);
}

function unexpected(divergences: readonly Divergence[]): readonly Divergence[] {
  return divergences.filter((divergence) => {
    if (divergence.kind === "PERMISSION" || divergence.kind === "ESCAPE") return true;
    return !isArrayIndexName(divergence.property);
  });
}

describe("the measured-class battery over every `packages/pnl` door", () => {
  it("derives a non-trivial amount of key material from the inputs", () => {
    expect(KEY_MATERIAL.length).toBeGreaterThan(50);
    for (const required of [
      "price",
      "amount",
      "accountRef",
      "skipChecks",
      "optin",
      "optout",
      "when",
      "get",
      "values",
      "disc",
    ]) {
      expect(KEY_MATERIAL).toContain(required);
    }
  });

  it("THE BOUND: permission never varies and no throw escapes, over every class", () => {
    expect(render(unexpected(sweep(SCENARIOS, KEY_MATERIAL)))).toEqual([]);
  });

  it("THE BOUND holds for the `optin`/`optout` PAIR (neither name alone flips it)", () => {
    expect(render(unexpected(sweepRequiredKeyWaiver(SCENARIOS)))).toEqual([]);
  });

  it("the honest fold is byte-identical under every class", () => {
    const clean = honestFold();
    expect(clean.startsWith("OK ")).toBe(true);
    const divergences = sweep([{ name: "honest fold", run: honestFold }], KEY_MATERIAL);
    expect(render(unexpected(divergences))).toEqual([]);
    expect(divergences.every((divergence) => divergence.polluted.startsWith("REFUSED"))).toBe(true);
  });
});

describe("totality: a hostile value produces a typed refusal, never an exception", () => {
  const HOSTILE: readonly (readonly [string, () => unknown])[] = [
    ["a Proxy", () => new Proxy({ ...TRADE }, {})],
    [
      "a throwing getter on a declared key",
      () => {
        const value: Record<string, unknown> = { ...TRADE };
        Object.defineProperty(value, "shares", {
          get: () => {
            throw new Error("hostile");
          },
          enumerable: true,
          configurable: true,
        });
        return value;
      },
    ],
    [
      "a cycle",
      () => {
        const value: Record<string, unknown> = { ...TRADE };
        value["self"] = value;
        return value;
      },
    ],
    ["a class instance", () => new (class extends Object {})()],
    ["a bigint field", () => ({ ...TRADE, shares: 10n })],
  ];

  for (const [label, build] of HOSTILE) {
    it(`refuses ${label} rather than throwing`, () => {
      const result = applyPnlRecord(EMPTY, build());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusals.map((refusal) => refusal.code)).toEqual(["PNL_INPUT_INVALID"]);
    });
  }

  it("refuses a hostile snapshot input and a hostile evidence booking the same way", () => {
    const folded = applyPnlRecord(EMPTY, TRADE);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(computePnlSnapshot(folded.value, new Proxy({ ...SNAPSHOT_INPUT }, {})).ok).toBe(false);
    expect(PnlSettlementEvidence.from([new Proxy({ ...REWARD_BOOKING }, {})]).ok).toBe(false);
  });

  it("`emptyPnlState` keeps its documented THROW and does not gain a new one", () => {
    expect(() => emptyPnlState({ scope: "NOBODY" } as never)).toThrow();
    expect(() => emptyPnlState(new Proxy({}, {}) as never)).toThrow();
    expect(emptyPnlState(IDENTITY).recordCount).toBe(0);
  });
});

describe("D4: what the door emits has no prototype", () => {
  it("a folded state, its identity, its owner and its lots are prototype-free", () => {
    const folded = applyPnlRecord(EMPTY, TRADE);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(Object.getPrototypeOf(folded.value)).toBeNull();
    expect(Object.getPrototypeOf(folded.value.identity)).toBeNull();
    expect(Object.getPrototypeOf(folded.value.owner)).toBeNull();
    expect(Object.getPrototypeOf(folded.value.lots.get("YES-TOKEN"))).toBeNull();
  });

  it("a snapshot, its per-version breakdowns and its persistence row are prototype-free", () => {
    const folded = foldPnlRecords(IDENTITY, [TRADE, FEE]);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    const snapshot = computePnlSnapshot(folded.value, SNAPSHOT_INPUT);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const first = snapshot.value[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.getPrototypeOf(first.feesByScheduleVersion)).toBeNull();
    expect(Object.getPrototypeOf(toPnlSnapshotRow(first))).toBeNull();
  });

  it("`toPnlSnapshotRow` reads OWN fields only: a missing measure stays missing", () => {
    // The mapper is TOTAL by contract, so it cannot refuse — what it can do is
    // refuse to be ANSWERED by the prototype. A snapshot carrying no
    // `capitalCommitted` produces a row whose `capitalCommitted` is undefined,
    // not one carrying somebody else's number.
    const folded = foldPnlRecords(IDENTITY, [TRADE, FEE]);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    const snapshot = computePnlSnapshot(folded.value, SNAPSHOT_INPUT);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const first = snapshot.value[0];
    if (first === undefined) return;
    const partial: Record<string, unknown> = { ...first };
    delete partial["capitalCommitted"];
    const row = withInherited("capitalCommitted", "999999", () =>
      toPnlSnapshotRow(partial as never),
    );
    expect(row.capitalCommitted).toBeUndefined();
    // and the honest mapping is untouched
    expect(toPnlSnapshotRow(first).capitalCommitted).toBe(first.capitalCommitted);
  });
});
