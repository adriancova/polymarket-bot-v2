/**
 * `CONTROL-2` — the trader halt door, the cache's four states, and the
 * surfaces they feed (`trader-halts.ts`). The PostgreSQL source itself is
 * driven against a real database in
 * `test/integration/control-api/postgres/trader-halts-postgres.test.ts`; the
 * trader's REAL row builder is driven through this door in
 * `test/integration/control-api/trader-halt-shape.test.ts`.
 *
 * The rule every test here serves: a path that says "no halts" while a halt is
 * open, or while the read failed, is the defect.
 */

import { describe, expect, it } from "vitest";

import { PLATFORM_METRIC_FAMILIES, platformMetricFamily, renderExpositionFor } from "@polymarket-bot/observability";

import { ControlApi, READ_REFRESH_DEADLINE_MS, type ApiRequest, type ApiResponse, type ControlApiOptions } from "./api.js";
import { OperatorRegistry } from "./auth.js";
import { TraderHealthCache, type HealthReadResult, type TraderHealthSource } from "./health-source.js";
import {
  FAKE_OPERATOR_TOKEN,
  FAKE_READER_TOKEN,
  bearer,
  createHarness,
  healthDocument,
  traderHaltFetch,
  traderHaltRow,
} from "./testing/index.js";
import {
  AbsentTraderHaltSource,
  InMemoryTraderHaltSource,
  TRADER_HALT_INCIDENT_KEYS,
  TRADER_HALT_LIST_LIMIT,
  TRADER_HALT_STATES,
  TraderHaltCache,
  inTraderHaltNamespace,
  readTraderHaltFetch,
  traderHaltSamples,
  traderHaltScopeOf,
  traderHaltsDocument,
  type TraderHaltFetch,
  type TraderHaltSource,
} from "./trader-halts.js";

const MARKET = traderHaltRow();
const INSTANCE = traderHaltRow({
  incident_id: "01930000-0000-7000-8000-00000000a002",
  incident_key: TRADER_HALT_INCIDENT_KEYS.STRATEGY_INSTANCE,
  market_id: null,
  instance_id: "01930000-0000-7000-8000-00000000c001",
  failure_class: "RISK_BREAKER",
});
const GLOBAL = traderHaltRow({
  incident_id: "01930000-0000-7000-8000-00000000a003",
  incident_key: TRADER_HALT_INCIDENT_KEYS.GLOBAL,
  market_id: null,
  instance_id: "01930000-0000-7000-8000-00000000c001",
  failure_class: "TRANSPORT_UNAVAILABLE",
  action: "FULL_HALT",
});

function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return { method: "GET", path: "/v1/health", authorization: bearer(FAKE_OPERATOR_TOKEN), body: undefined, ...overrides };
}

function parse(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function haltsOf(response: ApiResponse): Record<string, unknown> {
  return parse(response)["traderHalts"] as Record<string, unknown>;
}

/** A cache over an in-memory source that has been read once with `result`. */
async function readOnce(result: unknown): Promise<TraderHaltCache> {
  const cache = new TraderHaltCache(new InMemoryTraderHaltSource(result));
  await cache.refresh();
  return cache;
}

describe("the door: a self-consistent fetch is classified, every scope counted", () => {
  it("counts the trader's three scopes and lists each row with its scope, no irregularity", () => {
    const read = readTraderHaltFetch(traderHaltFetch([MARKET, INSTANCE, GLOBAL]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.halts.total).toBe(3);
    expect({ ...read.halts.byScope }).toEqual({ GLOBAL: 1, MARKET: 1, STRATEGY_INSTANCE: 1, UNRECOGNIZED: 0 });
    expect(read.halts.listed.map((row) => row.scope)).toEqual(["MARKET", "STRATEGY_INSTANCE", "GLOBAL"]);
    expect(read.halts.listed.every((row) => row.irregularities.length === 0)).toBe(true);
    // C1-HALTS: the `action` column is read through the door, never shown.
    expect(read.halts.listed.every((row) => !("action" in row))).toBe(true);
    expect(read.halts.irregular).toBe(0);
    expect(read.halts.truncated).toBe(false);
    expect(read.halts.listed[0]).toMatchObject({
      incidentKey: "TRADER_HALT:MARKET",
      marketId: MARKET["market_id"],
      instanceId: null,
      failureClass: "STALE_BOOK",
      detail: "market book is stale",
      openedAt: "2026-10-04T00:00:00.000000Z",
      status: "OPEN",
    });
  });

  it("an empty, consistent fetch is zero open rows — the only route to NONE_OPEN", () => {
    const read = readTraderHaltFetch(traderHaltFetch([]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.halts.total).toBe(0);
    expect(read.halts.listed).toEqual([]);
  });

  it("a key in the namespace that is none of the trader's three counts as UNRECOGNIZED — never dropped", () => {
    const odd = traderHaltRow({ incident_key: "TRADER_HALT:SOMETHING_NEW", market_id: null });
    const lower = traderHaltRow({ incident_id: "01930000-0000-7000-8000-00000000a009", incident_key: "trader_halt:market" });
    const read = readTraderHaltFetch(traderHaltFetch([odd, lower]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.halts.total).toBe(2);
    expect(read.halts.byScope.UNRECOGNIZED).toBe(2);
    expect(read.halts.listed.map((row) => row.scope)).toEqual(["UNRECOGNIZED", "UNRECOGNIZED"]);
    expect(read.halts.listed[0]?.irregularities.join(" ")).toContain("not one of the trader's three scope keys");
    expect(read.halts.irregular).toBe(2);
  });

  it("an IRREGULAR row is counted by its key and listed with what is wrong — never dropped", () => {
    const rows = [
      traderHaltRow({ market_id: null }),
      traderHaltRow({ incident_id: "01930000-0000-7000-8000-00000000a011", instance_id: "x" }),
      traderHaltRow({ incident_id: "01930000-0000-7000-8000-00000000a012", incident_key: TRADER_HALT_INCIDENT_KEYS.STRATEGY_INSTANCE }),
      traderHaltRow({ incident_id: "01930000-0000-7000-8000-00000000a013", incident_key: TRADER_HALT_INCIDENT_KEYS.GLOBAL }),
      traderHaltRow({ incident_id: "01930000-0000-7000-8000-00000000a014", severity: "NOTIFY" }),
      traderHaltRow({ incident_id: "01930000-0000-7000-8000-00000000a015", environment: "LIVE" }),
    ];
    const read = readTraderHaltFetch(traderHaltFetch(rows));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.halts.total).toBe(6);
    expect(read.halts.irregular).toBe(6);
    const said = read.halts.listed.map((row) => row.irregularities.join("; "));
    expect(said[0]).toContain("MARKET halt row names no market_id");
    expect(said[1]).toContain("MARKET halt row names an instance_id");
    expect(said[2]).toContain("STRATEGY_INSTANCE halt row names no instance_id");
    expect(said[2]).toContain("STRATEGY_INSTANCE halt row names a market_id");
    expect(said[3]).toContain("GLOBAL halt row names a market_id");
    expect(said[4]).toContain("severity NOTIFY");
    expect(said[5]).toContain("environment LIVE");
  });

  it("a MITIGATING row is open: only RESOLVED leaves", () => {
    const read = readTraderHaltFetch(traderHaltFetch([traderHaltRow({ status: "MITIGATING" })]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.halts.total).toBe(1);
    expect(read.halts.listed[0]?.status).toBe("MITIGATING");
  });

  it("MANY open rows: the counts are exact, the list is the limit, and it says truncated", () => {
    const listed = Array.from({ length: TRADER_HALT_LIST_LIMIT }, (_, index) =>
      traderHaltRow({ incident_id: `01930000-0000-7000-8000-${String(index).padStart(12, "0")}` }),
    );
    const read = readTraderHaltFetch(traderHaltFetch(listed, { total: "5000", market: "4000", global: "999" }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.halts.total).toBe(5000);
    expect({ ...read.halts.byScope }).toEqual({ GLOBAL: 999, MARKET: 4000, STRATEGY_INSTANCE: 0, UNRECOGNIZED: 1 });
    expect(read.halts.listed).toHaveLength(TRADER_HALT_LIST_LIMIT);
    expect(read.halts.truncated).toBe(true);
  });

  it("text from the table reaches the operator ESCAPED: no raw control or format character", () => {
    const rlo = String.fromCodePoint(0x202e);
    const esc = String.fromCodePoint(0x1b);
    const read = readTraderHaltFetch(traderHaltFetch([traderHaltRow({ detail: `a${rlo}b${esc}[2J`, account_ref: `acct${rlo}` })]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.halts.listed[0]?.detail).toBe("a\\u{202E}b\\u{1B}[2J");
    expect(read.halts.listed[0]?.accountRef).toBe("acct\\u{202E}");
  });
});

describe("the door REFUSES a fetch it cannot trust — and the state is then UNKNOWN, never NONE_OPEN", () => {
  const SCHEMA = "failed its schema";
  const cases: readonly { readonly label: string; readonly fetch: () => unknown; readonly says: string }[] = [
    { label: "not data at all", fetch: () => "nothing", says: "" },
    { label: "a fetch with a getter", fetch: () => Object.defineProperty({ rows: [] }, "counts", { get: () => [], enumerable: true }), says: "" },
    { label: "no counting row", fetch: () => ({ counts: [], rows: [] }), says: "" },
    { label: "two counting rows", fetch: () => ({ counts: [...traderHaltFetch([]).counts, ...traderHaltFetch([]).counts], rows: [] }), says: "" },
    { label: "an extra column", fetch: () => traderHaltFetch([{ ...MARKET, surprise: "x" }]), says: SCHEMA },
    { label: "a missing column", fetch: () => traderHaltFetch([Object.fromEntries(Object.entries(MARKET).filter(([key]) => key !== "detail"))]), says: SCHEMA },
    { label: "a count as a number", fetch: () => ({ ...traderHaltFetch([]), counts: [{ total: 0, global: "0", market: "0", strategy_instance: "0" }] }), says: SCHEMA },
    { label: "a negative count", fetch: () => traderHaltFetch([], { total: "-1" }), says: SCHEMA },
    { label: "a count with a leading zero", fetch: () => traderHaltFetch([], { total: "01" }), says: SCHEMA },
    // …refused by the SCHEMA even where the rest of the fetch is consistent with it.
    { label: "a consistent count with a leading zero", fetch: () => traderHaltFetch([MARKET], { total: "01", market: "01" }), says: SCHEMA },
    { label: "a count beyond a safe integer", fetch: () => traderHaltFetch([], { total: "1234567890123456" }), says: SCHEMA },
    // The bound holds at the SCHEMA, before any count is compared.
    { label: "more rows than the limit", fetch: () => traderHaltFetch(Array.from({ length: TRADER_HALT_LIST_LIMIT + 1 }, () => MARKET)), says: SCHEMA },
    { label: "a detail over the column bound", fetch: () => traderHaltFetch([traderHaltRow({ detail: "x".repeat(4001) })]), says: SCHEMA },
    { label: "scoped counts above the total", fetch: () => traderHaltFetch([MARKET], { total: "1", global: "1" }), says: "scoped rows" },
    { label: "rows listed but a zero count", fetch: () => traderHaltFetch([MARKET], { total: "0", market: "0" }), says: "listed 1 rows where its own count says 0" },
    { label: "a count with fewer rows listed than it says", fetch: () => traderHaltFetch([MARKET], { total: "2", market: "2" }), says: "listed 1 rows where its own count says 2" },
    { label: "more rows of a scope listed than counted", fetch: () => traderHaltFetch([MARKET, MARKET], { market: "1", global: "1" }), says: "listed 2 MARKET rows but counted 1" },
    { label: "a RESOLVED row listed as open", fetch: () => traderHaltFetch([traderHaltRow({ status: "RESOLVED" })]), says: "RESOLVED row" },
    { label: "a row outside the namespace", fetch: () => traderHaltFetch([traderHaltRow({ incident_key: "RECONCILE_BREAK" })], { market: "0" }), says: "outside the TRADER_HALT: namespace" },
  ];

  for (const entry of cases) {
    it(entry.label, async () => {
      const read = readTraderHaltFetch(entry.fetch());
      expect(read.ok, entry.label).toBe(false);
      if (!read.ok && entry.says !== "") expect(read.detail).toContain(entry.says);
      const cache = await readOnce(entry.fetch());
      expect(cache.view().state).toBe("UNKNOWN");
      expect(cache.readCounts()).toEqual({ REFUSED: 1 });
      const document = traderHaltsDocument(cache);
      expect(document["openTotal"]).toBeNull();
      expect(document["openByScope"]).toBeNull();
      expect(String(document["detail"])).toMatch(/^REFUSED: /u);
    });
  }

  it("is TOTAL: a value that throws while being read is refused, never thrown", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("boom");
        },
      },
    );
    const read = readTraderHaltFetch(hostile);
    expect(read.ok).toBe(false);
  });
});

describe("the cache: four states, fail closed, nothing retained across a failed read", () => {
  it("before any read: UNKNOWN (NOT_READ), never NONE_OPEN", () => {
    const cache = new TraderHaltCache(new InMemoryTraderHaltSource(traderHaltFetch([])));
    const view = cache.view();
    expect(view.state).toBe("UNKNOWN");
    if (view.state === "UNKNOWN") expect(view.reason).toBe("NOT_READ");
    expect(cache.readCounts()).toEqual({});
  });

  it("an unconfigured source is NOT_CONFIGURED and is never fetched", async () => {
    let fetched = 0;
    const source: TraderHaltSource = {
      configured: false,
      fetch: () => {
        fetched += 1;
        return Promise.resolve({ fetched: true, result: traderHaltFetch([]) });
      },
    };
    const cache = new TraderHaltCache(source);
    expect((await cache.refresh()).state).toBe("NOT_CONFIGURED");
    expect(fetched).toBe(0);
    expect(cache.readCounts()).toEqual({});
    const absent = new TraderHaltCache(new AbsentTraderHaltSource("the reason a deployment gave"));
    const view = absent.view();
    expect(view.state).toBe("NOT_CONFIGURED");
    if (view.state === "NOT_CONFIGURED") expect(view.detail).toBe("the reason a deployment gave");
  });

  it("OPEN with a row; NONE_OPEN with none", async () => {
    expect((await readOnce(traderHaltFetch([MARKET]))).view().state).toBe("OPEN");
    expect((await readOnce(traderHaltFetch([]))).view().state).toBe("NONE_OPEN");
  });

  it("a fetch that fails is UNKNOWN (UNAVAILABLE), with the source's reason", async () => {
    const source = new InMemoryTraderHaltSource();
    source.fail("ops.incidents could not be read: permission denied for table incidents");
    const cache = new TraderHaltCache(source);
    const view = await cache.refresh();
    expect(view.state).toBe("UNKNOWN");
    if (view.state === "UNKNOWN") {
      expect(view.reason).toBe("UNAVAILABLE");
      expect(view.detail).toContain("permission denied");
    }
    expect(cache.readCounts()).toEqual({ UNAVAILABLE: 1 });
  });

  it("a source that THROWS is contained: UNKNOWN (UNAVAILABLE)", async () => {
    const cache = new TraderHaltCache({ configured: true, fetch: () => Promise.reject(new Error("driver exploded")) });
    const view = await cache.refresh();
    expect(view.state).toBe("UNKNOWN");
    if (view.state === "UNKNOWN") expect(view.detail).toContain("driver exploded");
    const sync = new TraderHaltCache({
      configured: true,
      fetch: (): Promise<TraderHaltFetch> => {
        throw new Error("thrown synchronously");
      },
    });
    expect((await sync.refresh()).state).toBe("UNKNOWN");
  });

  it("NOTHING IS RETAINED: a failed read after an OPEN or a NONE_OPEN read is UNKNOWN, and the counts are gone", async () => {
    for (const first of [traderHaltFetch([MARKET]), traderHaltFetch([])]) {
      const source = new InMemoryTraderHaltSource(first);
      const cache = new TraderHaltCache(source);
      expect(["OPEN", "NONE_OPEN"]).toContain((await cache.refresh()).state);
      source.fail("the database went away");
      expect((await cache.refresh()).state).toBe("UNKNOWN");
      expect(traderHaltsDocument(cache)["openTotal"]).toBeNull();
      expect(traderHaltSamples(cache).some((sample) => sample.name === "control_trader_halts_open")).toBe(false);
      // …and a refused read the same.
      source.set({ counts: [], rows: [] });
      expect((await cache.refresh()).state).toBe("UNKNOWN");
      expect(cache.readCounts()).toEqual({ OK: 1, REFUSED: 1, UNAVAILABLE: 1 });
    }
  });

  it("a REFUSED read straight after an OPEN or a NONE_OPEN read is UNKNOWN — the earlier count is not kept", async () => {
    for (const first of [traderHaltFetch([MARKET]), traderHaltFetch([])]) {
      const source = new InMemoryTraderHaltSource(first);
      const cache = new TraderHaltCache(source);
      expect(["OPEN", "NONE_OPEN"]).toContain((await cache.refresh()).state);
      source.set(traderHaltFetch([MARKET], { total: "0" }));
      const view = await cache.refresh();
      expect(view.state).toBe("UNKNOWN");
      if (view.state === "UNKNOWN") expect(view.reason).toBe("REFUSED");
      expect(traderHaltsDocument(cache)["openTotal"]).toBeNull();
    }
  });

  it("a long failure detail is bounded and escaped", async () => {
    const source = new InMemoryTraderHaltSource();
    source.fail(`${String.fromCodePoint(0x1b)}${"x".repeat(5000)}`);
    const view = await new TraderHaltCache(source).refresh();
    expect(view.state).toBe("UNKNOWN");
    if (view.state !== "UNKNOWN") return;
    expect(view.detail.startsWith("\\u{1B}")).toBe(true);
    expect(view.detail.length).toBeLessThan(520);
  });
});

describe("the namespace and the scope keys", () => {
  it("the namespace is TRADER_HALT: in any case; the scopes are the trader's three keys exactly", () => {
    expect(inTraderHaltNamespace("TRADER_HALT:GLOBAL")).toBe(true);
    expect(inTraderHaltNamespace("trader_halt:x")).toBe(true);
    expect(inTraderHaltNamespace("TRADER_HALT")).toBe(false);
    expect(inTraderHaltNamespace("TRADERXHALT:GLOBAL")).toBe(false);
    expect(traderHaltScopeOf("TRADER_HALT:GLOBAL")).toBe("GLOBAL");
    expect(traderHaltScopeOf("TRADER_HALT:MARKET")).toBe("MARKET");
    expect(traderHaltScopeOf("TRADER_HALT:STRATEGY_INSTANCE")).toBe("STRATEGY_INSTANCE");
    expect(traderHaltScopeOf("trader_halt:global")).toBe("UNRECOGNIZED");
    expect(traderHaltScopeOf("TRADER_HALT:GLOBAL ")).toBe("UNRECOGNIZED");
  });
});

describe("the metrics: the state is always explicit, the counts only from a read that succeeded", () => {
  const render = (cache: TraderHaltCache): string => renderExpositionFor(PLATFORM_METRIC_FAMILIES, traderHaltSamples(cache));

  it("OPEN: the state, every scope's count, and the read", async () => {
    const body = render(await readOnce(traderHaltFetch([MARKET, GLOBAL])));
    expect(body).toContain('control_trader_halts_state{state="OPEN"} 1');
    expect(body).toContain('control_trader_halts_state{state="NONE_OPEN"} 0');
    expect(body).toContain('control_trader_halts_state{state="UNKNOWN"} 0');
    expect(body).toContain('control_trader_halts_state{state="NOT_CONFIGURED"} 0');
    expect(body).toContain('control_trader_halts_open{scope="GLOBAL"} 1');
    expect(body).toContain('control_trader_halts_open{scope="MARKET"} 1');
    expect(body).toContain('control_trader_halts_open{scope="STRATEGY_INSTANCE"} 0');
    expect(body).toContain('control_trader_halts_open{scope="UNRECOGNIZED"} 0');
    expect(body).toContain('control_trader_halt_reads_total{outcome="OK"} 1');
  });

  it("NONE_OPEN: zeros are present, and only here", async () => {
    const body = render(await readOnce(traderHaltFetch([])));
    expect(body).toContain('control_trader_halts_state{state="NONE_OPEN"} 1');
    expect(body).toContain('control_trader_halts_open{scope="MARKET"} 0');
  });

  it("UNKNOWN and NOT_CONFIGURED: the open family is ABSENT — never a zero", async () => {
    const source = new InMemoryTraderHaltSource();
    const unknown = new TraderHaltCache(source);
    await unknown.refresh();
    const notConfigured = new TraderHaltCache(new AbsentTraderHaltSource());
    const notRead = new TraderHaltCache(new InMemoryTraderHaltSource(traderHaltFetch([])));
    for (const [cache, state] of [
      [unknown, "UNKNOWN"],
      [notConfigured, "NOT_CONFIGURED"],
      [notRead, "UNKNOWN"],
    ] as const) {
      const body = render(cache);
      expect(body).toContain(`control_trader_halts_state{state="${state}"} 1`);
      expect(body).not.toContain("control_trader_halts_open");
    }
    expect(render(unknown)).toContain('control_trader_halt_reads_total{outcome="UNAVAILABLE"} 1');
    expect(render(notConfigured)).not.toContain("control_trader_halt_reads_total");
  });

  it("every state is one of the four, and exactly one is 1", async () => {
    for (const result of [traderHaltFetch([MARKET]), traderHaltFetch([]), { counts: [] }]) {
      const samples = traderHaltSamples(await readOnce(result)).filter((sample) => sample.name === "control_trader_halts_state");
      expect(samples.map((sample) => sample.labels?.["state"])).toEqual([...TRADER_HALT_STATES]);
      expect(samples.filter((sample) => sample.value === 1)).toHaveLength(1);
    }
  });

  // `CONTROL-2` r1 (S1): the families are the PLATFORM table's, category
  // `halts`, and this is their only producer — the pin
  // `packages/observability/src/control/metric-families.test.ts` names.
  it("the producer pin: traderHaltSamples emits EXACTLY the platform table's three trader-halt families, with only declared labels", async () => {
    const caches = [
      await readOnce(traderHaltFetch([MARKET, GLOBAL])),
      await readOnce(traderHaltFetch([])),
      await readOnce({ counts: [] }),
      new TraderHaltCache(new AbsentTraderHaltSource()),
    ];
    const emitted = new Set<string>();
    for (const cache of caches) {
      for (const sample of traderHaltSamples(cache)) {
        emitted.add(sample.name);
        const family = platformMetricFamily(sample.name);
        expect(family, sample.name).toBeDefined();
        expect(family?.category, sample.name).toBe("halts");
        for (const key of Object.keys(sample.labels ?? {})) expect(family?.labels ?? [], `${sample.name} ${key}`).toContain(key);
      }
    }
    const declared = PLATFORM_METRIC_FAMILIES.filter((family) => family.name.startsWith("control_trader_halt")).map((family) => family.name);
    expect([...emitted].sort()).toEqual([...declared].sort());
    expect(declared.sort()).toEqual(["control_trader_halt_reads_total", "control_trader_halts_open", "control_trader_halts_state"]);
    expect(platformMetricFamily("control_trader_halts_state")?.type).toBe("gauge");
    expect(platformMetricFamily("control_trader_halts_open")?.type).toBe("gauge");
    expect(platformMetricFamily("control_trader_halt_reads_total")?.type).toBe("counter");
  });
});

describe("through the API: the health answer and the metrics carry the halts, read on the request", () => {
  it("an authorized health read READS the source, and shows OPEN halts with their rows", async () => {
    const source = new InMemoryTraderHaltSource(traderHaltFetch([MARKET, INSTANCE]));
    const { api } = createHarness({ traderHaltSource: source });
    const halts = haltsOf(await api.handle(request()));
    expect(source.fetches).toBe(1);
    expect(halts["state"]).toBe("OPEN");
    expect(halts["configured"]).toBe(true);
    expect(halts["openTotal"]).toBe(2);
    expect(halts["openByScope"]).toEqual({ GLOBAL: 0, MARKET: 1, STRATEGY_INSTANCE: 1, UNRECOGNIZED: 0 });
    expect((halts["listed"] as unknown[]).length).toBe(2);
    expect(String(halts["note"])).toContain("row is not resolved");
    expect(halts["reads"]).toEqual({ OK: 1 });
  });

  it("a later read sees the table AS IT IS THEN: a halt that appears after the first read is shown on the next", async () => {
    const source = new InMemoryTraderHaltSource(traderHaltFetch([]));
    const { api } = createHarness({ traderHaltSource: source });
    expect(haltsOf(await api.handle(request()))["state"]).toBe("NONE_OPEN");
    source.set(traderHaltFetch([GLOBAL]));
    expect(haltsOf(await api.handle(request()))["state"]).toBe("OPEN");
    const metrics = (await api.handle(request({ path: "/v1/metrics" }))).body;
    expect(metrics).toContain('control_trader_halts_open{scope="GLOBAL"} 1');
    expect(source.fetches).toBe(3);
  });

  it("a failed read answers UNKNOWN — never NONE_OPEN, never the previous count", async () => {
    const source = new InMemoryTraderHaltSource(traderHaltFetch([MARKET]));
    const { api } = createHarness({ traderHaltSource: source });
    expect(haltsOf(await api.handle(request()))["state"]).toBe("OPEN");
    source.fail("ops.incidents did not answer within 2000 ms");
    const halts = haltsOf(await api.handle(request()));
    expect(halts["state"]).toBe("UNKNOWN");
    expect(halts["openTotal"]).toBeNull();
    expect(String(halts["detail"])).toContain("did not answer within 2000 ms");
    expect(String(halts["note"])).toContain("NOT 'no halts'");
    const metrics = (await api.handle(request({ path: "/v1/metrics" }))).body;
    expect(metrics).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
    expect(metrics).not.toContain("control_trader_halts_open");
  });

  it("NOT_CONFIGURED: never read, and said plainly", async () => {
    const { api } = createHarness({ traderHaltSource: new AbsentTraderHaltSource("no PostgreSQL client here") });
    const halts = haltsOf(await api.handle(request()));
    expect(halts["state"]).toBe("NOT_CONFIGURED");
    expect(halts["configured"]).toBe(false);
    expect(halts["detail"]).toBe("no PostgreSQL client here");
    expect(String(halts["note"])).toContain("NOT 'no halts'");
    const metrics = (await api.handle(request({ path: "/v1/metrics" }))).body;
    expect(metrics).toContain('control_trader_halts_state{state="NOT_CONFIGURED"} 1');
  });

  it("an anonymous or unauthorized caller makes the API read NOTHING", async () => {
    const source = new InMemoryTraderHaltSource(traderHaltFetch([]));
    const { api } = createHarness({
      traderHaltSource: source,
      operators: [
        { operatorId: "writer-only", token: FAKE_OPERATOR_TOKEN, grants: ["KILL_SWITCH"] },
        { operatorId: "reader-b", token: FAKE_READER_TOKEN, grants: ["READ"] },
      ],
    });
    for (const path of ["/v1/health", "/v1/metrics"]) {
      expect((await api.handle(request({ path, authorization: undefined }))).status).toBe(401);
      expect((await api.handle(request({ path }))).status).toBe(403);
    }
    expect(source.fetches).toBe(0);
    // A mutation and the other reads do not read it either.
    for (const path of ["/v1/run-state", "/v1/strategies", "/v1/kill-switch"]) {
      await api.handle(request({ path, authorization: bearer(FAKE_READER_TOKEN) }));
    }
    expect(source.fetches).toBe(0);
    await api.handle(request({ authorization: bearer(FAKE_READER_TOKEN) }));
    expect(source.fetches).toBe(1);
  });

  it("concurrent authorized reads share ONE read (single-flight)", async () => {
    let fetches = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source: TraderHaltSource = {
      configured: true,
      fetch: async () => {
        fetches += 1;
        await gate;
        return { fetched: true, result: traderHaltFetch([MARKET]) };
      },
    };
    const { api } = createHarness({ traderHaltSource: source });
    const answers = Promise.all([api.handle(request()), api.handle(request({ path: "/v1/metrics" })), api.handle(request())]);
    await Promise.resolve();
    release();
    const responses = await answers;
    expect(fetches).toBe(1);
    expect(haltsOf(responses[0] as ApiResponse)["state"]).toBe("OPEN");
    expect((responses[1] as ApiResponse).body).toContain('control_trader_halts_open{scope="MARKET"} 1');
  });
});

describe("CTL2-F1: an authorized health or metrics read ANSWERS by the answer deadline — a read still in flight is not current, and never an earlier NONE_OPEN", () => {
  const DEADLINE_MS = 80;
  const NO_ANSWER = "NO ANSWER";

  /** `work`, or {@link NO_ANSWER} once `ms` have passed (a scrape that gave up). */
  async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof NO_ANSWER> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<typeof NO_ANSWER>((resolve) => {
      timer = setTimeout(() => resolve(NO_ANSWER), ms);
    });
    try {
      return await Promise.race([work, gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A source whose first fetch answers `first` and whose second waits for {@link release}. */
  function slowSecondRead(first: unknown): { source: TraderHaltSource; fetches: () => number; release: (result: unknown) => void } {
    let fetches = 0;
    let release: (result: unknown) => void = () => undefined;
    const second = new Promise<TraderHaltFetch>((resolve) => {
      release = (result) => resolve({ fetched: true, result });
    });
    return {
      source: {
        configured: true,
        fetch: () => {
          fetches += 1;
          if (fetches === 1) return Promise.resolve({ fetched: true, result: first });
          if (fetches === 2) return second;
          return Promise.resolve({ fetched: true, result: traderHaltFetch([GLOBAL]) });
        },
      },
      fetches: () => fetches,
      release: (result) => release(result),
    };
  }

  it("a halt read still in flight at the deadline is UNKNOWN (OVERDUE) in /v1/metrics and /v1/health — not the earlier read's NONE_OPEN — and is recorded when it settles", async () => {
    const slow = slowSecondRead(traderHaltFetch([]));
    const { api, traderHalts } = createHarness({ traderHaltSource: slow.source, refreshDeadlineMs: DEADLINE_MS });
    const first = await within(api.handle(request({ path: "/v1/metrics" })), 2_000);
    expect(first === NO_ANSWER ? NO_ANSWER : first.body).toContain('control_trader_halts_state{state="NONE_OPEN"} 1');

    const started = Date.now();
    const metrics = await within(api.handle(request({ path: "/v1/metrics" })), DEADLINE_MS + 1_500);
    expect(metrics, "the scrape got no answer: the halt read held it").not.toBe(NO_ANSWER);
    if (metrics === NO_ANSWER) return;
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 10);
    expect(metrics.status).toBe(200);
    expect(metrics.body).toContain('control_trader_halts_state{state="UNKNOWN"} 1');
    expect(metrics.body).toContain('control_trader_halts_state{state="NONE_OPEN"} 0');
    expect(metrics.body).not.toContain("control_trader_halts_open");
    // Not counted: the read is still in flight.
    expect(metrics.body).toContain('control_trader_halt_reads_total{outcome="OK"} 1');
    expect(metrics.body).not.toContain('outcome="UNAVAILABLE"');

    // A health read now JOINS the outstanding read (single-flight) and is UNKNOWN too.
    const health = await within(api.handle(request()), DEADLINE_MS + 1_500);
    expect(health).not.toBe(NO_ANSWER);
    if (health === NO_ANSWER) return;
    const halts = haltsOf(health);
    expect(slow.fetches()).toBe(2);
    expect(halts["state"]).toBe("UNKNOWN");
    expect(halts["openTotal"]).toBeNull();
    expect(halts["openByScope"]).toBeNull();
    expect(String(halts["detail"])).toBe(
      `OVERDUE: this request's read of ops.incidents had not settled within the ${String(DEADLINE_MS)} ms answer deadline; it is ` +
        "still in flight, and a later read reports what it found",
    );
    expect(String(halts["note"])).toContain("NOT 'no halts'");
    // OVERDUE is the answer's, never the cache's: the cache still holds the earlier read.
    expect(traderHalts.view().state).toBe("NONE_OPEN");

    // The outstanding read settles — OPEN — and the cache records and counts it.
    slow.release(traderHaltFetch([MARKET]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(traderHalts.view().state).toBe("OPEN");
    expect({ ...traderHalts.readCounts() }).toEqual({ OK: 2 });
    const after = await within(api.handle(request({ path: "/v1/metrics" })), 2_000);
    expect(after === NO_ANSWER ? NO_ANSWER : after.body).toContain('control_trader_halts_open{scope="GLOBAL"} 1');
  });

  it("a trader health refresh still in flight at the deadline does not hold the halts: OPEN is answered, and the health is NOT current", async () => {
    let healthReads = 0;
    const hanging: TraderHealthSource = {
      read: (): Promise<HealthReadResult> => {
        healthReads += 1;
        return healthReads === 1
          ? Promise.resolve({ outcome: "OK", report: healthDocument() })
          : new Promise<HealthReadResult>(() => undefined);
      },
    };
    const harness = createHarness({ traderHaltSource: new InMemoryTraderHaltSource(traderHaltFetch([GLOBAL])) });
    const options: ControlApiOptions = {
      operators: new OperatorRegistry([{ operatorId: "reader-b", token: FAKE_READER_TOKEN, grants: ["READ"] }]),
      controlPlane: harness.controlPlane,
      health: new TraderHealthCache(hanging),
      environment: harness.environment,
      auditCapacity: 64,
      auditSize: () => harness.audit.size,
      refreshHealthOnRead: true,
      traderHalts: harness.traderHalts,
      refreshDeadlineMs: DEADLINE_MS,
    };
    const api = new ControlApi(options);
    const reader = { authorization: bearer(FAKE_READER_TOKEN) };
    const first = await within(api.handle(request({ ...reader, path: "/v1/metrics" })), 2_000);
    expect(first === NO_ANSWER ? NO_ANSWER : first.body).toContain("control_trader_health_current 1");

    const metrics = await within(api.handle(request({ ...reader, path: "/v1/metrics" })), DEADLINE_MS + 1_500);
    expect(metrics, "the scrape got no answer: the trader health refresh held it").not.toBe(NO_ANSWER);
    if (metrics === NO_ANSWER) return;
    expect(metrics.body).toContain('control_trader_halts_state{state="OPEN"} 1');
    expect(metrics.body).toContain('control_trader_halts_open{scope="GLOBAL"} 1');
    // The report is retained (available), and this read did not refresh it (not current).
    expect(metrics.body).toContain("control_trader_health_available 1");
    expect(metrics.body).toContain("control_trader_health_current 0");

    const health = await within(api.handle(request(reader)), DEADLINE_MS + 1_500);
    expect(health).not.toBe(NO_ANSWER);
    if (health === NO_ANSWER) return;
    const body = parse(health);
    expect(body["current"]).toBe(false);
    expect(body["available"]).toBe(true);
    expect(String(body["note"])).toContain(`did not answer within the ${String(DEADLINE_MS)} ms answer deadline`);
    expect(haltsOf(health)["state"]).toBe("OPEN");
    expect(healthReads).toBe(2);
  });

  it("the deadline is 8000 ms, and no composition may give a longer one — or a non-integer", () => {
    expect(READ_REFRESH_DEADLINE_MS).toBe(8_000);
    const harness = createHarness();
    const options = (refreshDeadlineMs: number): ControlApiOptions => ({
      operators: new OperatorRegistry([{ operatorId: "reader-b", token: FAKE_READER_TOKEN, grants: ["READ"] }]),
      controlPlane: harness.controlPlane,
      health: harness.health,
      environment: harness.environment,
      auditCapacity: 64,
      auditSize: () => harness.audit.size,
      traderHalts: harness.traderHalts,
      refreshDeadlineMs,
    });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, READ_REFRESH_DEADLINE_MS + 1, 60_000]) {
      expect(() => new ControlApi(options(bad)), String(bad)).toThrow(RangeError);
    }
    for (const good of [1, READ_REFRESH_DEADLINE_MS]) expect(() => new ControlApi(options(good)), String(good)).not.toThrow();
  });
});
