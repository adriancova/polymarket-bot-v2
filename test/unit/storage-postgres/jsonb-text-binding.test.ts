/**
 * `SER-2`: every `jsonb` write in `packages/storage-postgres` hands `pg` TEXT.
 *
 * THE CLASS. `JSON.stringify` resolves `toJSON` through the value's PROTOTYPE
 * CHAIN (ECMA-262 25.5.2), so a `toJSON` inherited from `Object.prototype` or
 * `Array.prototype` replaces the bytes of ANY object and ANY array, and one on
 * `BigInt.prototype` turns a bigint's `TypeError` into accepted bytes. Six
 * contexts (`SER-0`): three prototypes × {enumerable assignment,
 * non-enumerable `defineProperty`}.
 *
 * THE SITES (`docs/handoffs/SER-0-sweep.md`, area `postgres`, measured end to
 * end through real Kysely → `pg@8.23.0` `prepareValue`). At base every
 * repository handed Kysely the document OBJECT: `assertDecimalSafeJson`
 * judged it and returned the same reference, and the driver then serialized
 * it at bind time through the prototype chain — a guard-PASSED document was
 * stored as the injected `toJSON`'s answer, and a `bigint` inside an
 * unguarded document, refused with a `TypeError` in a clean process, became
 * accepted bytes under `BigInt.prototype`. A STRING parameter never reaches
 * the driver's object path (measured invariant in all six contexts).
 *
 * | site | column | guard |
 * | --- | --- | --- |
 * | `orders.ts` `recordSubmissionAttempt` | `submission_attempts.signed_payload` | decimal-guarded |
 * | `orders.ts` `recordSubmissionResponse` | `submission_attempts.response_payload` | UNGUARDED (venue evidence) |
 * | `orders.ts` `appendOrderEvent` | `order_events.payload` | decimal-guarded |
 * | `strategy.ts` `createDefinition` | `definitions.params_schema` | UNGUARDED (JSON Schema) |
 * | `strategy.ts` `createConfig` | `configs.parameters` | decimal-guarded |
 * | `catalog.ts` `registerMarket` | `markets.raw_metadata` (incl. the `?? {}` default) | UNGUARDED |
 * | `dataset-catalog.ts` `importDatasetManifest` | `dataset_manifests.{start,end}_event_identity`, `pinned_versions` | already TEXT, by `JSON.stringify` |
 *
 * THE PINS, per site: (a) the bound parameter is `typeof "string"`; (b) its
 * bytes equal a clean `JSON.stringify` of the same document (the FORMAT
 * guard — it passes at base for the three `dataset-catalog.ts` columns, which
 * were already text, and fails at base for the six object sites, which bound
 * an object); (c) six-context invariance with the injected `toJSON` counted
 * at zero; (d) a `bigint` inside an UNGUARDED document is refused in every
 * context, as the package's typed `DecimalSafeJsonError`.
 *
 * THE PROTOCOL (`test/unit/ledger/inherited-tojson.ts`, async form in
 * `./support/inherited-tojson-async.ts`): install, `await` the repository
 * call against the capturing fake, render a STRING, restore in a `finally`,
 * only then assert. The renderer applies the REAL driver's `prepareValue` to
 * any non-string it captures, INSIDE the window, so a run against the base
 * sources shows the bytes `pg` would have sent (`"INJECTED"`), not merely
 * "an object".
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DecimalSafeJsonError } from "../../../packages/storage-postgres/src/errors.js";
import { encodeJsonbText } from "../../../packages/storage-postgres/src/json.js";
import { createCatalogRepository } from "../../../packages/storage-postgres/src/repositories/catalog.js";
import {
  createDatasetCatalogRepository,
  type ImportDatasetManifestInput,
} from "../../../packages/storage-postgres/src/repositories/dataset-catalog.js";
import { createOrderRepository } from "../../../packages/storage-postgres/src/repositories/orders.js";
import { createStrategyRepository } from "../../../packages/storage-postgres/src/repositories/strategy.js";
import type { JsonInput } from "../../../packages/storage-postgres/src/schema/columns.js";
import { createCapturingDatabase } from "./support/capturing-db.js";
import {
  outcomeAsync,
  renderDivergences,
  sweepInheritedToJsonAsync,
  TOJSON_CONTEXTS,
  withInheritedToJsonAsync,
} from "./support/inherited-tojson-async.js";

// ---------------------------------------------------------------------------
// The driver's own bind-time serializer, for rendering a captured NON-string
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const requireFromStorage = createRequire(
  resolve(REPO_ROOT, "packages/storage-postgres/package.json"),
);
const { prepareValue } = requireFromStorage("pg/lib/utils") as {
  readonly prepareValue: (value: unknown) => unknown;
};

/**
 * What `pg` receives for the bound value: the string itself, or — for anything
 * else — what `pg@8.23.0`'s `prepareValue` makes of it. The second branch is
 * never taken at the tip; it is what makes a base run's divergence legible.
 */
function driverText(bound: unknown): string {
  if (typeof bound === "string") return `text:${bound}`;
  return `driver:${String(prepareValue(bound))}`;
}

// ---------------------------------------------------------------------------
// Documents and identities
// ---------------------------------------------------------------------------

const ID = "0190a3e0-0000-7000-8000-000000000001";
const EPOCH = "0190a3e0-0000-7000-8000-000000000002";
const AT = "2026-06-29T17:15:57.300Z";

/** Decimal-safe: strings, booleans, null, nested object, array. */
const GUARDED_DOCUMENT = {
  price: "0.42",
  size: "10",
  legs: [{ size: "10", side: "BUY" }, { size: "0", side: "SELL" }],
  negRisk: false,
  note: null,
  nested: { deep: ["a", "b"], flag: true },
} as const;

/** A JSON Schema: numbers are keywords here (the documented allowlist). */
const PARAMS_SCHEMA = {
  type: "object",
  properties: { ticks: { type: "string", maxLength: 8 }, ratio: { type: "number", maximum: 5 } },
  required: ["ticks"],
} as const;

/** Venue evidence, recorded as observed. */
const RESPONSE_PAYLOAD = {
  status: "ok",
  orderId: "0xabc",
  fills: [{ size: "1", price: "0.5" }],
  received: 3,
} as const;

/** Venue metadata, recorded as observed. */
const RAW_METADATA = {
  slug: "btc-up",
  tags: ["crypto", "btc"],
  volume: 12.5,
  nested: { active: true, note: null },
} as const;

const START_IDENTITY = { gatewayEpoch: EPOCH, ingestSeq: "1", receivedAt: AT, datasetRowOrdinal: 0 };
const END_IDENTITY = { gatewayEpoch: EPOCH, ingestSeq: "9", receivedAt: AT, datasetRowOrdinal: 8 };
const PINNED_VERSIONS = { feeSnapshotVersion: "fees/2026-08-24", settlementSpecVersions: ["s1", "s2"] };

function importInput(overrides: Partial<ImportDatasetManifestInput> = {}): ImportDatasetManifestInput {
  return {
    manifestKey: "2026-06-29T17-00Z",
    gatewayEpoch: EPOCH,
    manifestSha256: "a".repeat(64),
    normalizerVersion: "polymarket-public/market-channel/v1",
    runSeed: "42",
    startEventIdentity: START_IDENTITY,
    endEventIdentity: END_IDENTITY,
    pinnedVersions: PINNED_VERSIONS,
    source: "polymarket",
    endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    segmentFormat: "JSONL",
    segments: [
      {
        walSegmentId: `${EPOCH}-000000`,
        segmentIndex: 0,
        segmentSha256: "b".repeat(64),
        recordCount: 3,
        byteSize: 1600,
        firstIngestSeq: "1",
        lastIngestSeq: "9",
        firstReceivedAt: AT,
        lastReceivedAt: AT,
        fileUri: `${EPOCH}-000000.wal.jsonl`,
      },
    ],
    exclusions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// One driver per site: run the repository against a fresh capturing fake and
// answer the value it BOUND for the column
// ---------------------------------------------------------------------------

interface Site {
  readonly name: string;
  readonly guarded: boolean;
  readonly document: Readonly<Record<string, unknown>>;
  /** Binds `document` (or the site's default when `undefined`) and returns the bound value. */
  readonly bind: (document: Readonly<Record<string, unknown>> | undefined) => Promise<unknown>;
}

const SITES: readonly Site[] = [
  {
    name: "orders.recordSubmissionAttempt -> submission_attempts.signed_payload",
    guarded: true,
    document: GUARDED_DOCUMENT,
    bind: async (document) => {
      const capture = createCapturingDatabase();
      await createOrderRepository(capture.db).recordSubmissionAttempt({
        executionGroupId: ID,
        planId: ID,
        signedPayload: document as never,
        salt: "salt-1",
      });
      return capture.bound("execution.submission_attempts", "signed_payload");
    },
  },
  {
    name: "orders.recordSubmissionResponse -> submission_attempts.response_payload",
    guarded: false,
    document: RESPONSE_PAYLOAD,
    bind: async (document) => {
      const capture = createCapturingDatabase();
      await createOrderRepository(capture.db).recordSubmissionResponse({
        submissionAttemptId: ID,
        state: "RESPONDED",
        ...(document === undefined ? {} : { responsePayload: document as JsonInput }),
      });
      return capture.bound("execution.submission_attempts", "response_payload");
    },
  },
  {
    name: "orders.appendOrderEvent -> order_events.payload",
    guarded: true,
    document: GUARDED_DOCUMENT,
    bind: async (document) => {
      const capture = createCapturingDatabase({
        "execution.orders": [{ state: "LIVE", filled_shares: "0" }],
        "execution.order_events": [],
      });
      await createOrderRepository(capture.db).appendOrderEvent({
        orderId: ID,
        eventType: "VENUE_ACK",
        newState: "LIVE",
        source: "polymarket",
        occurredAt: AT,
        payload: document as never,
      });
      return capture.bound("execution.order_events", "payload");
    },
  },
  {
    name: "strategy.createDefinition -> definitions.params_schema",
    guarded: false,
    document: PARAMS_SCHEMA,
    bind: async (document) => {
      const capture = createCapturingDatabase();
      await createStrategyRepository(capture.db).createDefinition({
        strategyName: "static-bracket",
        codeVersion: "0.1.0",
        paramsSchema: document as JsonInput,
        stateSchemaVersion: 1,
        decisionContractVersion: 1,
      });
      return capture.bound("strategy.definitions", "params_schema");
    },
  },
  {
    name: "strategy.createConfig -> configs.parameters",
    guarded: true,
    document: GUARDED_DOCUMENT,
    bind: async (document) => {
      const capture = createCapturingDatabase({ "strategy.configs": [] });
      await createStrategyRepository(capture.db).createConfig({
        definitionId: ID,
        parameters: document as never,
        parametersHash: "c".repeat(64),
        validatedAt: AT,
        createdBy: "operator",
      });
      return capture.bound("strategy.configs", "parameters");
    },
  },
  {
    name: "catalog.registerMarket -> markets.raw_metadata",
    guarded: false,
    document: RAW_METADATA,
    bind: async (document) => {
      const capture = createCapturingDatabase();
      await createCatalogRepository(capture.db).registerMarket({
        conditionId: "0xcondition",
        questionTitle: "Will BTC be up?",
        parameters: {
          tickSize: "0.01",
          minimumOrderSize: "5",
          tradingDelaySeconds: 0,
          negRisk: false,
          lifecycleState: "OPEN",
        },
        tokens: [{ tokenId: "1", outcomeSide: "YES", outcomeLabel: "Yes" }],
        ...(document === undefined ? {} : { rawMetadata: document as JsonInput }),
        source: "polymarket",
        observedAt: AT,
      });
      return capture.bound("catalog.markets", "raw_metadata");
    },
  },
  {
    name: "datasetCatalog.importDatasetManifest -> dataset_manifests.start_event_identity",
    guarded: false,
    document: START_IDENTITY,
    bind: async (document) => {
      const capture = createCapturingDatabase({
        "data.raw_segments": [],
        "data.dataset_manifests": [],
      });
      await createDatasetCatalogRepository(capture.db).importDatasetManifest(
        importInput({ startEventIdentity: document ?? START_IDENTITY }),
      );
      return capture.bound("data.dataset_manifests", "start_event_identity");
    },
  },
  {
    name: "datasetCatalog.importDatasetManifest -> dataset_manifests.end_event_identity",
    guarded: false,
    document: END_IDENTITY,
    bind: async (document) => {
      const capture = createCapturingDatabase({
        "data.raw_segments": [],
        "data.dataset_manifests": [],
      });
      await createDatasetCatalogRepository(capture.db).importDatasetManifest(
        importInput({ endEventIdentity: document ?? END_IDENTITY }),
      );
      return capture.bound("data.dataset_manifests", "end_event_identity");
    },
  },
  {
    name: "datasetCatalog.importDatasetManifest -> dataset_manifests.pinned_versions",
    guarded: false,
    document: PINNED_VERSIONS,
    bind: async (document) => {
      const capture = createCapturingDatabase({
        "data.raw_segments": [],
        "data.dataset_manifests": [],
      });
      await createDatasetCatalogRepository(capture.db).importDatasetManifest(
        importInput({ pinnedVersions: document ?? PINNED_VERSIONS }),
      );
      return capture.bound("data.dataset_manifests", "pinned_versions");
    },
  },
];

const UNGUARDED = SITES.filter((site) => !site.guarded);
const GUARDED = SITES.filter((site) => site.guarded);

/** `document` with a `bigint` two levels down, past a plain object and an array. */
function withNestedBigint(document: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { ...document, extra: { list: [{ n: 1n }] } };
}

// ---------------------------------------------------------------------------

describe("every jsonb write hands pg text (SER-2)", () => {
  for (const site of SITES) {
    it(`${site.name}: binds a STRING whose bytes are the document's own JSON`, async () => {
      const bound = await site.bind(site.document);
      expect(typeof bound).toBe("string");
      expect(bound).toBe(JSON.stringify(site.document));
    });
  }

  it("binds the same text under all six inherited-toJSON contexts, the injected toJSON never invoked", async () => {
    const sweep = await sweepInheritedToJsonAsync(
      SITES.map((site) => ({
        name: site.name,
        render: async () => driverText(await site.bind(site.document)),
      })),
    );
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    for (const site of SITES) {
      expect(sweep.clean.get(site.name)).toBe(`ok:text:${JSON.stringify(site.document)}`);
    }
  });

  it("refuses a bigint inside an UNGUARDED document in every context, as DecimalSafeJsonError", async () => {
    const sweep = await sweepInheritedToJsonAsync(
      UNGUARDED.map((site) => ({
        name: site.name,
        render: async () => driverText(await site.bind(withNestedBigint(site.document))),
      })),
    );
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    for (const site of UNGUARDED) {
      expect(sweep.clean.get(site.name)).toMatch(
        /^threw:DecimalSafeJsonError:ECONOMIC_JSON_NUMBER:.*\.extra\.list\[0\]\.n is a bigint/u,
      );
    }
  });

  it("the refusal is the package's typed error, carrying the column and the path", async () => {
    const site = UNGUARDED[0];
    if (site === undefined) throw new Error("no unguarded site");
    let thrown: unknown;
    try {
      await site.bind(withNestedBigint(site.document));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DecimalSafeJsonError);
    const refusal = thrown as DecimalSafeJsonError;
    expect(refusal.code).toBe("ECONOMIC_JSON_NUMBER");
    expect(refusal.field).toBe("submission_attempts.response_payload");
    expect(refusal.path).toBe(".extra.list[0].n");
  });

  it("the GUARDED documents' bigint refusal is the guard's, unchanged, in every context", async () => {
    // Passes at base too: `assertDecimalSafeJson` already walked own data and
    // refused a bigint before anything reached the driver. Recorded so the
    // two halves of the rule are both pinned.
    const sweep = await sweepInheritedToJsonAsync(
      GUARDED.map((site) => ({
        name: site.name,
        render: async () => driverText(await site.bind(withNestedBigint(site.document))),
      })),
    );
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    for (const site of GUARDED) {
      expect(sweep.clean.get(site.name)).toMatch(/^threw:DecimalSafeJsonError:ECONOMIC_JSON_NUMBER:/u);
    }
  });

  it("binds null for an absent nullable document, and the text '{}' for raw_metadata's default", async () => {
    const response = createCapturingDatabase();
    await createOrderRepository(response.db).recordSubmissionResponse({
      submissionAttemptId: ID,
      state: "ABANDONED",
    });
    expect(response.bound("execution.submission_attempts", "response_payload")).toBeNull();

    const event = createCapturingDatabase({
      "execution.orders": [{ state: "LIVE", filled_shares: "0" }],
      "execution.order_events": [],
    });
    await createOrderRepository(event.db).appendOrderEvent({
      orderId: ID,
      eventType: "VENUE_ACK",
      newState: "LIVE",
      source: "polymarket",
      occurredAt: AT,
    });
    expect(event.bound("execution.order_events", "payload")).toBeNull();

    const market = SITES.find((site) => site.name.includes("raw_metadata"));
    if (market === undefined) throw new Error("no raw_metadata site");
    const bound = await market.bind(undefined);
    expect(bound).toBe("{}");
  });

  it("raw_metadata's `{}` default is the text '{}' in every context", async () => {
    const market = SITES.find((site) => site.name.includes("raw_metadata"));
    if (market === undefined) throw new Error("no raw_metadata site");
    const sweep = await sweepInheritedToJsonAsync([
      { name: "default", render: async () => driverText(await market.bind(undefined)) },
    ]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(sweep.clean.get("default")).toBe("ok:text:{}");
  });

  it("passes pre-serialized text through untouched (the caller's own bytes)", async () => {
    const text = '{"price":"0.42","legs":[{"size":"10"}]}';
    const capture = createCapturingDatabase();
    await createOrderRepository(capture.db).recordSubmissionAttempt({
      executionGroupId: ID,
      planId: ID,
      signedPayload: text,
      salt: "salt-2",
    });
    expect(capture.bound("execution.submission_attempts", "signed_payload")).toBe(text);
  });
});

// ---------------------------------------------------------------------------

describe("encodeJsonbText — the repository's encoder", () => {
  it("returns null for null and the string itself for text", () => {
    expect(encodeJsonbText(null, "c")).toBeNull();
    expect(encodeJsonbText('{"a":1}', "c")).toBe('{"a":1}');
  });

  it("encodes a null-prototype tree (what the strategy runtime's materializer emits)", () => {
    const tree = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(tree, "edge", { value: "0.012", enumerable: true, writable: true, configurable: true });
    const list: unknown[] = [];
    Object.defineProperty(list, "0", { value: "a", enumerable: true, writable: true, configurable: true });
    Object.defineProperty(tree, "list", { value: list, enumerable: true, writable: true, configurable: true });
    expect(encodeJsonbText(tree, "c")).toBe('{"edge":"0.012","list":["a"]}');
  });

  it("maps every non-bigint refusal to ECONOMIC_JSON_MALFORMED with the repository's path convention", () => {
    const cases: readonly { readonly document: Readonly<Record<string, unknown>>; readonly path: string; readonly kind: string }[] = [
      { document: { when: new Date(0) }, path: ".when", kind: "NON_PLAIN" },
      { document: { map: new Map() }, path: ".map", kind: "NON_PLAIN" },
      { document: { run: () => 1 }, path: ".run", kind: "EXECUTABLE" },
      { document: { sym: Symbol("s") }, path: ".sym", kind: "EXECUTABLE" },
      { document: { list: [1, () => 1] }, path: ".list[1]", kind: "EXECUTABLE" },
      {
        document: Object.defineProperty({}, "getter", { get: () => 1, enumerable: true }) as Record<string, unknown>,
        path: ".getter",
        kind: "ACCESSOR",
      },
    ];
    for (const entry of cases) {
      let thrown: unknown;
      try {
        encodeJsonbText(entry.document, "table.column");
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.kind).toBeInstanceOf(DecimalSafeJsonError);
      const refusal = thrown as DecimalSafeJsonError;
      expect(refusal.code, entry.kind).toBe("ECONOMIC_JSON_MALFORMED");
      expect(refusal.field).toBe("table.column");
      expect(refusal.path, entry.kind).toBe(entry.path);
      expect(refusal.message).toContain(`table.column${entry.path} is not representable in JSON (${entry.kind})`);
    }
  });

  it("maps a bigint at any depth to ECONOMIC_JSON_NUMBER, the wording the guard already uses", () => {
    let thrown: unknown;
    try {
      encodeJsonbText({ a: [{ n: 7n }] }, "table.column");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DecimalSafeJsonError);
    const refusal = thrown as DecimalSafeJsonError;
    expect(refusal.code).toBe("ECONOMIC_JSON_NUMBER");
    expect(refusal.path).toBe(".a[0].n");
    expect(refusal.message).toBe(
      "table.column.a[0].n is a bigint, which JSON cannot represent. Use a decimal string.",
    );
  });

  it("refuses a Date in every context rather than storing its toJSON answer", async () => {
    // At base a `Date` member became its ISO string through `Date.prototype.toJSON`
    // in the clean process and the injected answer under `Object.prototype` —
    // two different documents from one input, neither the caller's own data.
    const answers: string[] = [];
    for (const context of TOJSON_CONTEXTS) {
      const run = await withInheritedToJsonAsync(context, async () =>
        await outcomeAsync(async () => await Promise.resolve(encodeJsonbText({ when: new Date(0) }, "c") ?? "null")),
      );
      answers.push(`${run.result}|calls=${String(run.calls)}`);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toMatch(/^threw:DecimalSafeJsonError:ECONOMIC_JSON_MALFORMED:c\.when is not representable in JSON \(NON_PLAIN\)/u);
    expect(answers[0]).toMatch(/\|calls=0$/u);
  });
});
