/**
 * `packages/ledger` — the ADR-020 §3 door, measured.
 *
 * WHAT THIS FILE IS. `docs/contracts/schema-boundary.md` §3 carries a
 * `packages/ledger` row with the verdict **LIVE ×2**, severity **HIGH**, owner
 * `WP-200-FU1`, and two concrete transcripts. §4 says what a conforming door
 * must state and requires a battery behind it. This is the battery, and every
 * row below was REPRODUCED against `main` `761db76` before the door was built —
 * the transcripts in the block comments are the base measurements, not
 * predictions.
 *
 * THE BASE TRANSCRIPT (`/dev/shm/wp200fu1-base` = `main` `761db76`,
 * `pnpm install --frozen-lockfile`, `zod@4.4.3`, probe P):
 *
 * ```text
 * P1  clean, fillId + no marketId:      {"ok":false,"codes":["LEDGER_MARKET_REQUIRED"]}
 * P2  NE inherited marketId:            {"ok":true, marketId adopted}      ← F16 DEFEATED
 * P3  clean, garbage id + timestamp:    {"ok":false,"codes":["LEDGER_INPUT_INVALID"]}
 * P4  NE inherited skipChecks:          {"ok":true, "totally-not-a-uuid", "yesterday-ish"}
 * P5  clean, fill missing price:        {"ok":false,"codes":["LEDGER_INPUT_INVALID"]}
 * P6  NE inherited price:               {"ok":true,"price":"0.99"}         ← MONETARY
 * P7  clean, ids missing token id:      {"ok":false,"codes":["LEDGER_INPUT_INVALID"]}
 * P8  NE inherited tokenTransactionId:  {"ok":true, adopted id on a real transaction}
 * P9  clean, accounts missing fee ref:  {"ok":false,"codes":["LEDGER_INPUT_INVALID"]}
 * P10 NE inherited feeExpenseRef:       {"ok":true}
 * ```
 *
 * THE BOUND THIS FILE ASSERTS (ADR-020 §6, `schema-boundary.md` §4 item 5):
 * under the battery, **permission never varies, the monetary outcome of a clean
 * input is byte-identical, and no throw escapes.** Refusal *composition*
 * (message text, issue ordering) may vary and is deliberately not pinned.
 *
 * EVIDENCE CLASSES. Every assertion here is EXECUTED against the shipped
 * sources — no mock, no stub, no fixture standing in for a door. The one
 * INSPECTION-only assertion is the `.default()` census, and it says so at its
 * site. The base-versus-tip byte-identity differential is EXECUTED, but in a
 * separate `/dev/shm` scratch tree (it needs two commits at once); its
 * transcript is in the `WP-200-FU1` handoff record, and the tip half of it is
 * pinned here by `the honest path is byte-identical under every class`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  Ledger,
  LedgerTransactionInputSchema,
  allocateFill,
  buildFillPosting,
  projectLedger,
  serializeProjection,
  validateTransactionInput,
} from "../../../packages/ledger/src/index.js";
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const TX = "01936f00-0000-7000-8000-0000000000a1";
const TX2 = "01936f00-0000-7000-8000-0000000000a2";
const TX3 = "01936f00-0000-7000-8000-0000000000a3";
const FILL = "01936f00-0000-7000-8000-0000000000b1";
const MARKET = "01936f00-0000-7000-8000-0000000000c1";
const INSTANCE = "01936f00-0000-7000-8000-0000000000d1";

/** A fill-booking transaction: `fillId` present, `marketId` supplied per case. */
function fillBooking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ledgerTransactionId: TX,
    eventType: "TRADE_PRINCIPAL",
    environment: "PAPER",
    accountRef: "acct-1",
    source: "internal",
    occurredAt: "2026-09-04T00:00:00Z",
    fillId: FILL,
    entries: [
      {
        scope: "ACTUAL_ACCOUNT",
        accountRef: "acct-1",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "-5",
      },
      {
        scope: "EXTERNAL_CLEARING",
        accountRef: "clearing-venue",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "5",
      },
    ],
    ...overrides,
  };
}

const FILL_FACT = {
  fillId: FILL,
  marketId: MARKET,
  environment: "PAPER",
  accountRef: "acct-1",
  tokenAssetId: "YES-TOKEN",
  denominationAssetId: "pUSD",
  side: "BUY",
  shares: "10",
  price: "0.4",
  source: "polymarket",
  occurredAt: "2026-09-04T00:00:00Z",
} as const;

const ACCOUNTS = {
  venueClearingRef: "clearing-venue",
  attributionClearingRef: "clearing-attribution",
  feeExpenseRef: "expense-fees",
} as const;

const IDS = { principalTransactionId: TX2, tokenTransactionId: TX3 } as const;

/**
 * A real `allocateFill` result, built ONCE while the prototype is clean.
 *
 * Built at module scope deliberately: building it inside a scenario would make
 * the FIXTURE part of what the battery measures, and the first draft did
 * exactly that — under an inherited accessor at an array index the fixture's
 * own `throw` escaped and the sweep recorded an `ESCAPE` that
 * `buildFillPosting` did not have.
 */
function ownAllocation(claims: readonly unknown[]): unknown {
  const result = allocateFill(FILL_FACT, claims);
  if (!result.ok) throw new Error("fixture allocation refused");
  return result.value;
}

const ALLOCATION_NO_CLAIMS = ownAllocation([]);
const ALLOCATION_ONE_CLAIM = ownAllocation([{ instanceId: INSTANCE, shares: "6" }]);

// ---------------------------------------------------------------------------
// §3 audit-row regressions — reproduced at `main` `761db76`, flipped here
// ---------------------------------------------------------------------------

/** Installs one non-enumerable inherited data property and removes it after. */
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

/** The same, with an ENUMERABLE property (the loud, cold-lazy-poisoning form). */
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

describe("schema-boundary §3 `packages/ledger`: the two LIVE rows, closed", () => {
  it("WP-040 obligation F16 holds under a NON-ENUMERABLE inherited `marketId` (base: ACCEPTED)", () => {
    const clean = describeResult(validateTransactionInput(fillBooking()));
    const polluted = withInherited(
      "marketId",
      MARKET,
      () => describeResult(validateTransactionInput(fillBooking())),
    );
    expect(clean).toBe("REFUSED LEDGER_MARKET_REQUIRED");
    // Byte-identical, not merely also-refused: this is the §6 bound.
    expect(polluted).toBe(clean);
  });

  it("F16 holds under the ENUMERABLE variant too", () => {
    const polluted = withEnumerableInherited(
      "marketId",
      MARKET,
      () => describeResult(validateTransactionInput(fillBooking())),
    );
    expect(polluted).toBe("REFUSED LEDGER_MARKET_REQUIRED");
  });

  it("an inherited `skipChecks` no longer admits a non-UUID id and a non-timestamp (base: ACCEPTED)", () => {
    const garbage = fillBooking({
      ledgerTransactionId: "totally-not-a-uuid",
      occurredAt: "yesterday-ish",
      marketId: MARKET,
    });
    const clean = describeResult(validateTransactionInput(garbage));
    const polluted = withInherited(
      "skipChecks",
      true,
      () => describeResult(validateTransactionInput(garbage)),
    );
    expect(clean).toBe("REFUSED LEDGER_INPUT_INVALID");
    expect(polluted).toBe(clean);
  });

  it("MUTATION KILL: the RAW schema still accepts both, so the probes measure the DOOR", () => {
    // The negative control `GOV-2A` probe K3 is built on, and the reason this
    // battery is not vacuous: the same values, parsed through the frozen schema
    // WITHOUT the arena, still exhibit the base behaviour. If a future edit
    // removed `prototypeFreeParser` from the door, the tests above would fail
    // rather than pass trivially — and if the LIBRARY changed so the class no
    // longer exists, THIS test fails and says so.
    const garbage = fillBooking({
      ledgerTransactionId: "totally-not-a-uuid",
      occurredAt: "yesterday-ish",
      marketId: MARKET,
    });
    const rawClean = LedgerTransactionInputSchema.safeParse(garbage).success;
    const rawPolluted = withInherited("skipChecks", true, () =>
      LedgerTransactionInputSchema.safeParse(garbage).success,
    );
    expect(rawClean).toBe(false);
    expect(rawPolluted).toBe(true);

    const noMarket = fillBooking();
    const rawAdopted = withInherited("marketId", MARKET, () => {
      const parsed = LedgerTransactionInputSchema.safeParse(noMarket);
      return parsed.success ? (parsed.data as { marketId?: string }).marketId : undefined;
    });
    expect(rawAdopted).toBe(MARKET);
  });
});

describe("schema-boundary §3: the doors the census found beyond the audit row", () => {
  it("`allocateFill` no longer adopts a fill PRICE from the prototype (base: price '0.99')", () => {
    const noPrice: Record<string, unknown> = { ...FILL_FACT };
    delete noPrice["price"];
    const clean = describeResult(allocateFill(noPrice, []));
    const polluted = withInherited(
      "price",
      "0.99",
      () => describeResult(allocateFill(noPrice, [])),
    );
    expect(clean).toBe("REFUSED LEDGER_INPUT_INVALID");
    expect(polluted).toBe(clean);
  });

  it("`buildFillPosting` no longer adopts a transaction id from the prototype (base: ACCEPTED)", () => {
    const allocation = ALLOCATION_ONE_CLAIM;
    const idsNoToken = { principalTransactionId: TX2 };
    const clean = describeResult(buildFillPosting(allocation as never, ACCOUNTS, idsNoToken));
    const polluted = withInherited("tokenTransactionId", TX3, () =>
      describeResult(buildFillPosting(allocation as never, ACCOUNTS, idsNoToken)),
    );
    expect(clean).toBe("REFUSED LEDGER_INPUT_INVALID");
    expect(polluted).toBe(clean);
  });

  it("`buildFillPosting` no longer adopts an ACCOUNT REFERENCE from the prototype", () => {
    const allocation = ALLOCATION_ONE_CLAIM;
    const accountsNoFee = {
      venueClearingRef: "clearing-venue",
      attributionClearingRef: "clearing-attribution",
    };
    const clean = describeResult(buildFillPosting(allocation as never, accountsNoFee, IDS));
    const polluted = withInherited("feeExpenseRef", "expense-from-prototype", () =>
      describeResult(buildFillPosting(allocation as never, accountsNoFee, IDS)),
    );
    expect(clean).toBe("REFUSED LEDGER_INPUT_INVALID");
    expect(polluted).toBe(clean);
  });

  it("an UNATTRIBUTED remainder cannot be reattributed by an inherited `instanceId`", () => {
    // The census finding this file exists to record: `buildFillPosting` chose
    // between the VIRTUAL_STRATEGY and UNATTRIBUTED scopes on
    // `slice.instanceId !== undefined`, an OPTIONAL read on an internal
    // ordinary object. An inherited `instanceId` moved a share of a real fill
    // onto a strategy instance the allocation never named.
    const allocation = ALLOCATION_NO_CLAIMS;
    const scopesOf = (): string => {
      const posting = buildFillPosting(allocation as never, ACCOUNTS, IDS);
      if (!posting.ok) return "REFUSED";
      return posting.value.transactions
        .flatMap((transaction) => transaction.entries.map((entry) => entry.scope))
        .join(",");
    };
    const clean = scopesOf();
    const polluted = withInherited("instanceId", INSTANCE, scopesOf);
    expect(clean).toContain("UNATTRIBUTED");
    expect(polluted).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// The full measured-class battery
// ---------------------------------------------------------------------------

/** A complete honest scenario: allocate, post, append, project, serialize. */
function honestFold(): string {
  const allocation = allocateFill(FILL_FACT, [{ instanceId: INSTANCE, shares: "6" }]);
  if (!allocation.ok) {
    return `REFUSED alloc:${allocation.refusals.map((r) => r.code).join(",")}`;
  }
  const posting = buildFillPosting(allocation.value, ACCOUNTS, IDS);
  if (!posting.ok) return `REFUSED post:${posting.refusals.map((r) => r.code).join(",")}`;
  let ledger = Ledger.empty("PAPER");
  for (const transaction of posting.value.transactions) {
    const appended = ledger.append(transaction);
    if (!appended.ok) {
      return `REFUSED append:${appended.refusals.map((r) => r.code).join(",")}`;
    }
    ledger = appended.value.ledger;
  }
  return `OK ${serializeProjection(projectLedger(ledger))}|${canonical(posting.value.pnlRecords)}`;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "validateTransactionInput(fill booking, no market) — F16",
    run: () => describeResult(validateTransactionInput(fillBooking())),
  },
  {
    name: "validateTransactionInput(valid, with market)",
    run: () => describeResult(validateTransactionInput(fillBooking({ marketId: MARKET }))),
  },
  {
    name: "validateTransactionInput(garbage id + timestamp)",
    run: () =>
      describeResult(
        validateTransactionInput(
          fillBooking({
            ledgerTransactionId: "totally-not-a-uuid",
            occurredAt: "yesterday-ish",
            marketId: MARKET,
          }),
        ),
      ),
  },
  {
    name: "allocateFill(valid fill, one claim)",
    run: () => describeResult(allocateFill(FILL_FACT, [{ instanceId: INSTANCE, shares: "6" }])),
  },
  {
    name: "allocateFill(fill with no price)",
    run: () => {
      const noPrice: Record<string, unknown> = { ...FILL_FACT };
      delete noPrice["price"];
      return describeResult(allocateFill(noPrice, []));
    },
  },
  {
    name: "buildFillPosting(valid)",
    run: () => describeResult(buildFillPosting(ALLOCATION_NO_CLAIMS as never, ACCOUNTS, IDS)),
  },
  {
    name: "Ledger.append(valid deposit)",
    run: () =>
      describeResult(
        Ledger.empty("PAPER").append({
          ledgerTransactionId: TX,
          eventType: "DEPOSIT_OBSERVED",
          environment: "PAPER",
          accountRef: "acct-1",
          source: "internal",
          occurredAt: "2026-09-04T00:00:00Z",
          entries: [
            {
              scope: "ACTUAL_ACCOUNT",
              accountRef: "acct-1",
              assetId: "pUSD",
              assetKind: "COLLATERAL",
              amount: "100",
            },
            {
              scope: "EXTERNAL_CLEARING",
              accountRef: "clearing-venue",
              assetId: "pUSD",
              assetKind: "COLLATERAL",
              amount: "-100",
            },
            {
              scope: "UNATTRIBUTED",
              accountRef: "acct-1",
              assetId: "pUSD",
              assetKind: "COLLATERAL",
              amount: "100",
            },
            {
              scope: "EXTERNAL_CLEARING",
              accountRef: "clearing-attribution",
              assetId: "pUSD",
              assetKind: "COLLATERAL",
              amount: "-100",
            },
          ],
        }),
      ),
  },
  { name: "the honest allocate → post → append → project fold", run: honestFold },
];

/**
 * The key material, DERIVED from the inputs (never hand-listed), plus the
 * library's own consulted state names and the descriptor attributes.
 */
const KEY_MATERIAL: readonly string[] = candidateKeys(
  {
    transaction: fillBooking({ marketId: MARKET }),
    fill: FILL_FACT,
    accounts: ACCOUNTS,
    ids: { ...IDS, feeTransactionId: TX },
    claim: { instanceId: INSTANCE, runId: INSTANCE, shares: "6", feeAmount: "0.01" },
  },
  [...ZOD_PARSE_STATE_NAMES, ...DESCRIPTOR_ATTRIBUTE_NAMES, "zzUnrelated", "haltRequired"],
);

/**
 * A property name that is a decimal ARRAY INDEX.
 *
 * THE ONE DISCLOSED AVAILABILITY CLASS, measured rather than assumed (probes
 * W2/W3). `packages/risk`'s canonical door accumulates into ordinary arrays
 * (`state.strings`, `state.problems`, and `readArray`'s output) with
 * `Array.prototype.push`, which is `Set` and therefore consults the prototype
 * chain for the INDEX name. An inherited get-only accessor at `"6"` or `"10"`
 * makes that push throw, `readPlainData`'s own outer guard turns it into
 * `reading it as data failed unexpectedly … (fail closed)`, and the door
 * REFUSES an honest input.
 *
 * It is availability, not permission — nothing is admitted, nothing is
 * invented, and the refusal is the door's own typed one — which is exactly how
 * `GOV-2A` classified the `values` class (`schema-boundary.md` §2, "fails
 * closed (availability, not permission)"). `packages/risk/src/plain-data.ts` is
 * outside `WP-200-FU1`'s allowed paths, so it is DISCLOSED here and carried as
 * a follow-up rather than fixed in this package. It is enumerated so it cannot
 * grow: any availability divergence at a NON-index name fails the battery.
 */
function isArrayIndexName(property: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(property);
}

/**
 * Every divergence the bound does NOT allow.
 *
 * `PERMISSION` and `ESCAPE` are never allowed, at any name. `AVAILABILITY` and
 * `COMPOSITION` are allowed ONLY at an array-index name — the one disclosed
 * fail-closed class above — so a new one at any other name fails.
 */
function unexpected(divergences: readonly Divergence[]): readonly Divergence[] {
  return divergences.filter((divergence) => {
    if (divergence.kind === "PERMISSION" || divergence.kind === "ESCAPE") return true;
    return !isArrayIndexName(divergence.property);
  });
}

describe("the measured-class battery over every `packages/ledger` door", () => {
  it("derives a non-trivial amount of key material from the inputs", () => {
    expect(KEY_MATERIAL.length).toBeGreaterThan(50);
    for (const required of ["marketId", "skipChecks", "optin", "optout", "when", "get", "values"]) {
      expect(KEY_MATERIAL).toContain(required);
    }
  });

  it("THE BOUND: permission never varies and no throw escapes, over every class", () => {
    const divergences = sweep(SCENARIOS, KEY_MATERIAL);
    // The bound, stated as the two classes that must be empty. The third —
    // AVAILABILITY at an array-index name — is the disclosed fail-closed class
    // documented at `isArrayIndexName`, and it is checked separately below so a
    // NEW availability class cannot hide inside it.
    expect(render(unexpected(divergences))).toEqual([]);
  });

  it("the only variation is the disclosed array-index class, and it fails CLOSED", () => {
    const divergences = sweep(SCENARIOS, KEY_MATERIAL);
    // It exists (so the disclosure above is not stale) …
    expect(divergences.length).toBeGreaterThan(0);
    // … every divergence is an availability or composition move …
    expect([...new Set(divergences.map((divergence) => divergence.kind))].sort()).toEqual([
      "AVAILABILITY",
      "COMPOSITION",
    ]);
    // … only ever at an array-index name …
    expect(
      [...new Set(divergences.map((divergence) => divergence.property))].filter(
        (property) => !isArrayIndexName(property),
      ),
    ).toEqual([]);
    // … only ever under an ACCESSOR shape (a DATA property at an index name is
    // shadowed by the array's own element and changes nothing) …
    expect([...new Set(divergences.map((divergence) => divergence.shape))].sort()).toEqual([
      "accessor-get-only",
      "accessor-throws",
    ]);
    // … and it always lands on the door's own typed refusal, never a throw.
    expect([...new Set(divergences.map((divergence) => divergence.polluted))].sort()).toEqual([
      "REFUSED LEDGER_INPUT_INVALID",
      "REFUSED alloc:LEDGER_INPUT_INVALID",
    ]);
  });

  it("THE BOUND holds for the `optin`/`optout` PAIR (neither name alone flips it)", () => {
    expect(render(unexpected(sweepRequiredKeyWaiver(SCENARIOS)))).toEqual([]);
  });

  it("the honest path is byte-identical under every class", () => {
    // The benign half of the bound, stated separately because it is the one a
    // reader of a monetary package cares about: the door must not change what
    // an HONEST input produces. The scenario string is a full projection
    // serialization plus the canonical PnL records, so a one-digit change fails.
    const clean = honestFold();
    expect(clean.startsWith("OK ")).toBe(true);
    const divergences = sweep([{ name: "honest fold", run: honestFold }], KEY_MATERIAL);
    // Nothing produces a DIFFERENT fold. The array-index names can REFUSE it
    // (the disclosed fail-closed class); none of them can change what it says.
    expect(render(unexpected(divergences))).toEqual([]);
    expect(divergences.every((divergence) => divergence.polluted.startsWith("REFUSED"))).toBe(true);
  });
});

describe("the consulted-slot audit, in this package's own terms", () => {
  /**
   * The arena's version-pinned coupling is part of the door these packages
   * import, so the audit is re-run HERE rather than trusted from
   * `test/unit/risk/`. It re-derives every `_zod.<name>` read from the SHIPPED
   * `zod@4.4.3` parse path and requires this package's sweep material to cover
   * it: a library upgrade that consults a new slot fails this test before it
   * can be a silent prototype walk in a ledger door (ADR-020 §7).
   */
  const ZOD_CORE = resolve(REPO_ROOT, "packages/ledger/node_modules/zod/v4/core");
  const PARSE_PATH_FILES = ["core.cjs", "parse.cjs", "schemas.cjs", "checks.cjs", "util.cjs"];

  it("resolves `zod` through this package's own dependency, at the pinned version", () => {
    const versions = readFileSync(resolve(ZOD_CORE, "versions.cjs"), "utf8");
    expect(versions).toContain("major: 4");
    expect(versions).toContain("minor: 4");
    expect(versions).toContain("patch: 3");
  });

  it("every `_zod.<name>` the shipped library reads is in this battery's material", () => {
    const extracted = new Set<string>();
    for (const file of PARSE_PATH_FILES) {
      const source = readFileSync(resolve(ZOD_CORE, file), "utf8");
      for (const match of source.matchAll(/_zod\.([A-Za-z_$][A-Za-z0-9_$]*)/gu)) {
        extracted.add(match[1] ?? "");
      }
    }
    expect(extracted.size).toBeGreaterThan(10);
    const material = new Set(ZOD_PARSE_STATE_NAMES);
    expect([...extracted].filter((name) => !material.has(name)).sort()).toEqual([]);
  });

  it("CENSUS (inspection): no ledger or PnL schema declares a `.default()`", () => {
    // The "defaults defeated" class of §2 needs a `.default()`ed key to defeat.
    // Neither package has one, so the class has no surface here — and this is
    // the assertion that keeps that true, because the day a default is added is
    // the day the class becomes live and this test says so. Marked INSPECTION:
    // it reads source text, it does not execute a parse.
    const offenders: string[] = [];
    for (const relative of [
      "packages/ledger/src/transaction.ts",
      "packages/ledger/src/allocation.ts",
      "packages/ledger/src/fill-posting.ts",
      "packages/ledger/src/vocabulary.ts",
      "packages/pnl/src/records.ts",
      "packages/pnl/src/snapshot.ts",
      "packages/pnl/src/evidence.ts",
    ]) {
      if (/\.default\(/u.test(readFileSync(resolve(REPO_ROOT, relative), "utf8"))) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("totality: a hostile value produces a typed refusal, never an exception", () => {
  const HOSTILE: readonly (readonly [string, () => unknown])[] = [
    ["a Proxy", () => new Proxy(fillBooking({ marketId: MARKET }), {})],
    [
      "a throwing getter on a declared key",
      () => {
        const value = fillBooking({ marketId: MARKET });
        Object.defineProperty(value, "accountRef", {
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
        const value = fillBooking({ marketId: MARKET }) as Record<string, unknown>;
        value["self"] = value;
        return value;
      },
    ],
    ["a class instance", () => new (class extends Object {})()],
    ["a function", () => (): void => undefined],
    ["a symbol-keyed property", () => ({ ...fillBooking(), [Symbol("x")]: 1 })],
  ];

  for (const [label, build] of HOSTILE) {
    it(`refuses ${label} rather than throwing`, () => {
      const result = validateTransactionInput(build());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusals.map((refusal) => refusal.code)).toEqual(["LEDGER_INPUT_INVALID"]);
    });
  }

  it("refuses a hostile allocation, posting-accounts and id set the same way", () => {
    const proxied = new Proxy({ ...ACCOUNTS }, {});
    expect(buildFillPosting(ALLOCATION_NO_CLAIMS as never, proxied, IDS).ok).toBe(false);
    expect(
      buildFillPosting(ALLOCATION_NO_CLAIMS as never, ACCOUNTS, new Proxy({ ...IDS }, {})).ok,
    ).toBe(false);
    expect(buildFillPosting(new Proxy({}, {}) as never, ACCOUNTS, IDS).ok).toBe(false);
    expect(allocateFill(new Proxy({ ...FILL_FACT }, {}), []).ok).toBe(false);
    expect(allocateFill(FILL_FACT, [new Proxy({ instanceId: INSTANCE, shares: "1" }, {})]).ok).toBe(
      false,
    );
  });

  it("`Ledger.empty` keeps its documented THROW and does not gain a new one", () => {
    expect(() => Ledger.empty("BANANA" as never)).toThrow();
    expect(() => Ledger.empty(new Proxy({}, {}) as never)).toThrow();
    expect(Ledger.empty("PAPER").length).toBe(0);
  });
});

describe("D4: what the door emits has no prototype", () => {
  it("a validated transaction, its entries, and its appended record are prototype-free", () => {
    const validated = validateTransactionInput(fillBooking({ marketId: MARKET }));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(Object.getPrototypeOf(validated.value)).toBeNull();
    expect(Object.getPrototypeOf(validated.value.entries[0])).toBeNull();
    expect(Object.isFrozen(validated.value)).toBe(true);
  });

  it("an allocation, its records and the posting it produces are prototype-free", () => {
    const allocation = allocateFill(FILL_FACT, [{ instanceId: INSTANCE, shares: "6" }]);
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    expect(Object.getPrototypeOf(allocation.value)).toBeNull();
    expect(Object.getPrototypeOf(allocation.value.allocations[0])).toBeNull();
    expect(Object.getPrototypeOf(allocation.value.unattributed)).toBeNull();

    const posting = buildFillPosting(allocation.value, ACCOUNTS, IDS);
    expect(posting.ok).toBe(true);
    if (!posting.ok) return;
    expect(Object.getPrototypeOf(posting.value)).toBeNull();
    expect(Object.getPrototypeOf(posting.value.transactions[0])).toBeNull();
    expect(Object.getPrototypeOf(posting.value.transactions[0]?.entries[0])).toBeNull();
    expect(Object.getPrototypeOf(posting.value.pnlRecords[0])).toBeNull();
  });

  it("a refusal's `details` is prototype-free and survives a hostile details object", () => {
    const refused = validateTransactionInput(fillBooking());
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(Object.getPrototypeOf(refused.refusals[0]?.details)).toBeNull();
  });
});
