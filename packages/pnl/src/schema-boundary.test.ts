/**
 * The COLD-LAZY class, closed — `docs/contracts/schema-boundary.md` §2 row 7
 * and the second half of the §3 `packages/pnl` row.
 *
 * WHY THIS FILE IS PACKAGE-LOCAL AND SEPARATE. Every other class in the battery
 * can be measured against a module that is already loaded. This one cannot: it
 * is about what happens the FIRST time a schema object parses anything, so the
 * probe needs a module registry it can reset, which is a `vitest` capability
 * and belongs beside the package it resets. The rest of the `packages/pnl`
 * battery is `test/unit/ledger/schema-boundary-pnl.test.ts`.
 *
 * WHAT WAS MEASURED AT `main` `761db76` (probe R, `/dev/shm/wp200fu1-base`):
 *
 * ```text
 * R1 import state.js with ONE enumerable Object.prototype.zzUnrelated = 1
 *      → IMPORTED (module evaluation itself does not parse, so it does not throw)
 * R2 the first parse in that fresh module, still polluted
 *      → ESCAPED TypeError: Cannot read properties of undefined (reading 'values')
 * R3 the SAME call afterwards, prototype restored to clean
 *      → ESCAPED Error: Invalid discriminated union option at index "0"  ← POISONED
 * ```
 *
 * A CORRECTION TO THE PACKET, DISCLOSED. The `WP-200-FU1` task packet, quoting
 * the `GOV-2A` round-2 reviewer, says the throw was measured "escaping at
 * MODULE IMPORT of `packages/pnl/src/state.js`". Re-measured at base, module
 * EVALUATION does not throw (R1) — nothing in this package parses at load — and
 * the escape is on the first PARSE after a fresh import (R2), which then
 * poisons the schema for the process (R3). The `setupFiles` route that would
 * make an import-time throw observable was tried and is CONTAMINATED: a control
 * suite importing nothing from the workspace fails identically under the same
 * pollution (`TypeError: Spread syntax requires ...iterable[Symbol.iterator] to
 * be a function`), so that failure is `vitest`'s own machinery, not this
 * package's. The audit row's substance — an escaped `TypeError` from a cold
 * first parse, and permanent poisoning — is reproduced exactly; only the
 * "at module import" phrasing is corrected.
 *
 * THE BOUND: after the fix, a fresh import followed by a polluted first parse
 * answers exactly what a clean process answers, and the schema is still usable
 * afterwards.
 *
 * EVIDENCE CLASS: EXECUTED, against freshly imported copies of the shipped
 * modules.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const IDENTITY = {
  scope: "ACTUAL_ACCOUNT",
  environment: "PAPER",
  accountRef: "acct-1",
} as const;

const TRADE = {
  kind: "TRADE",
  ref: "01936f00-0000-7000-8000-000000000101",
  owner: { scope: "ACTUAL_ACCOUNT", accountRef: "acct-1" },
  marketId: "01936f00-0000-7000-8000-000000000104",
  tokenAssetId: "YES-TOKEN",
  denominationAsset: "pUSD",
  side: "BUY",
  shares: "10",
  price: "0.4",
} as const;

/** The pollution that triggers the class: ONE enumerable inherited data property. */
function pollute(): void {
  Object.defineProperty(Object.prototype, "zzUnrelated", {
    value: 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function clean(): void {
  delete (Object.prototype as Record<string, unknown>)["zzUnrelated"];
}

interface StateModule {
  readonly emptyPnlState: (identity: unknown) => unknown;
  readonly applyPnlRecord: (
    state: unknown,
    record: unknown,
  ) => { readonly ok: boolean; readonly refusals?: readonly { readonly code: string }[] };
}

interface RecordsModule {
  readonly PnlRecordSchema: { safeParse: (value: unknown) => { readonly success: boolean } };
}

/** Loads a FRESH copy of the module graph: new schema objects, new arena. */
async function freshState(): Promise<StateModule> {
  return (await import("./state.js")) as unknown as StateModule;
}

async function freshRecords(): Promise<RecordsModule> {
  return (await import("./records.js")) as unknown as RecordsModule;
}

describe("the cold first parse of `PnlRecordSchema`'s door", () => {
  beforeEach(() => {
    vi.resetModules();
    clean();
  });

  it("imports under enumerable pollution without throwing (the arena builds)", async () => {
    let outcome: string;
    try {
      pollute();
      await freshState();
      outcome = "IMPORTED";
    } catch {
      outcome = "THREW AT IMPORT";
    } finally {
      clean();
    }
    expect(outcome).toBe("IMPORTED");
  });

  it("answers a COLD first parse under pollution exactly as a clean process does (base: ESCAPED TypeError)", async () => {
    // The module is imported while polluted, so the arena is BUILT polluted
    // too — the hardest case, and the one the base transcript failed.
    let cold: string;
    let state: unknown;
    let module: StateModule | undefined;
    try {
      pollute();
      module = await freshState();
      state = module.emptyPnlState(IDENTITY);
      const first = module.applyPnlRecord(state, TRADE);
      cold = first.ok ? "OK" : `REFUSED ${(first.refusals ?? []).map((r) => r.code).join(",")}`;
    } catch {
      cold = "ESCAPED";
    } finally {
      clean();
    }
    expect(cold).toBe("OK");

    // … and the schema is NOT poisoned: the next parse, in a clean process,
    // still works. At base this threw `Invalid discriminated union option`.
    expect(module).toBeDefined();
    if (module === undefined) return;
    let warm: string;
    try {
      const second = module.applyPnlRecord(module.emptyPnlState(IDENTITY), TRADE);
      warm = second.ok ? "OK" : `REFUSED ${(second.refusals ?? []).map((r) => r.code).join(",")}`;
    } catch {
      warm = "ESCAPED (POISONED)";
    }
    expect(warm).toBe("OK");
  });

  it("answers a cold first parse under pollution when the module was imported CLEAN", async () => {
    const module = await freshState();
    const state = module.emptyPnlState(IDENTITY);
    let cold: string;
    try {
      pollute();
      const first = module.applyPnlRecord(state, TRADE);
      cold = first.ok ? "OK" : `REFUSED ${(first.refusals ?? []).map((r) => r.code).join(",")}`;
    } catch {
      cold = "ESCAPED";
    } finally {
      clean();
    }
    expect(cold).toBe("OK");
  });

  it("MUTATION KILL: the RAW union in the SAME fresh module still breaks, so the door is what changed", async () => {
    // The negative control. If this stops failing, the library's behaviour has
    // changed and the three assertions above have become vacuous — which is
    // exactly the state a battery must not be allowed to reach silently.
    const records = await freshRecords();
    let raw: string;
    try {
      pollute();
      raw = records.PnlRecordSchema.safeParse(TRADE).success ? "PARSED" : "REFUSED";
    } catch {
      raw = "THREW";
    } finally {
      clean();
    }
    expect(raw).toBe("THREW");

    // … and it stays broken in a clean process: the poisoning is permanent,
    // which is why the door has to warm at load rather than catch at the site.
    let afterwards: string;
    try {
      afterwards = records.PnlRecordSchema.safeParse(TRADE).success ? "PARSED" : "REFUSED";
    } catch {
      afterwards = "THREW (POISONED)";
    }
    expect(afterwards).toBe("THREW (POISONED)");
  });
});
