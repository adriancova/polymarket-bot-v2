/**
 * `SER-2`: the TEXT every repository now binds for a `jsonb` column round-trips
 * through a real PostgreSQL as the document that was written.
 *
 * The unit layer (`test/unit/storage-postgres/jsonb-text-binding.test.ts`)
 * pins WHAT the repositories hand Kysely — a string, the document's own bytes,
 * invariant under an inherited `toJSON`. `docs/handoffs/SER-0-sweep.md` named
 * one residual it could not measure without Docker: "PostgreSQL's acceptance
 * of the substituted bytes — inferred from the DDL". This file closes the
 * complementary half for the REPAIRED bytes: a string parameter bound to a
 * `jsonb` column is accepted, parsed and read back equal to the document, for
 * every site the round routed. Nothing here pollutes a prototype — an
 * inherited `toJSON` may not be held across an awaited query against a live
 * driver — the unit layer owns that pin.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp, hashOf } from "@polymarket-bot/storage-postgres/testing";
import { beforeAll, describe, expect, it } from "vitest";

import { useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("jsonb_text_binding");

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "jsonb_text" });
});

/** Decimal-safe, with an array, a nested object, `null`, `false`, and characters JSON must escape. */
const GUARDED_DOCUMENT = {
  price: "0.42",
  size: "10",
  legs: [{ size: "10", side: "BUY" }, { size: "0", side: "SELL" }],
  negRisk: false,
  note: null,
  text: "tab\tquote\"backslash\\lf\nunicodeé\u{1F600}",
  nested: { deep: ["a", "b"], flag: true },
};

describe("every jsonb write hands pg text, and PostgreSQL reads the document back (SER-2)", () => {
  it("submission_attempts.signed_payload (decimal-guarded)", async () => {
    const attemptId = await context.repositories.orders.recordSubmissionAttempt({
      executionGroupId: chain.executionGroupId,
      planId: chain.planId,
      attemptOrdinal: 41,
      signedPayload: GUARDED_DOCUMENT,
      salt: "ser-2-signed",
    });
    const stored = await context.db
      .selectFrom("execution.submission_attempts")
      .select(["signed_payload"])
      .where("submission_attempt_id", "=", attemptId)
      .executeTakeFirstOrThrow();
    expect(stored.signed_payload).toEqual(GUARDED_DOCUMENT);
  });

  it("submission_attempts.response_payload (unguarded venue evidence; numbers kept as observed)", async () => {
    const attemptId = await context.repositories.orders.recordSubmissionAttempt({
      executionGroupId: chain.executionGroupId,
      planId: chain.planId,
      attemptOrdinal: 42,
      signedPayload: { price: "0.42" },
      salt: "ser-2-response",
    });
    const response = { status: "ok", orderId: "0xabc", fills: [{ size: "1", price: "0.5" }], received: 3 };
    await context.repositories.orders.recordSubmissionResponse({
      submissionAttemptId: attemptId,
      state: "RESPONDED",
      responseStatus: "OK",
      responsePayload: response,
    });
    const stored = await context.db
      .selectFrom("execution.submission_attempts")
      .select(["response_payload", "state"])
      .where("submission_attempt_id", "=", attemptId)
      .executeTakeFirstOrThrow();
    expect(stored.state).toBe("RESPONDED");
    expect(stored.response_payload).toEqual(response);
  });

  it("order_events.payload (decimal-guarded) and null when absent", async () => {
    const orderId = await context.repositories.orders.insertOrder({
      planId: chain.planId,
      executionGroupId: chain.executionGroupId,
      submissionAttemptId: chain.submissionAttemptId,
      marketId: chain.marketId,
      tokenId: chain.tokenId,
      side: "BUY",
      limitPrice: "0.42",
      originalShares: "100",
      state: "LIVE",
    });
    const withPayload = await context.repositories.orders.appendOrderEvent({
      orderId,
      eventType: "VENUE_ACK",
      newState: "LIVE",
      source: "polymarket",
      occurredAt: fixtureTimestamp(),
      payload: GUARDED_DOCUMENT,
    });
    const withoutPayload = await context.repositories.orders.appendOrderEvent({
      orderId,
      eventType: "VENUE_ACK",
      newState: "LIVE",
      source: "polymarket",
      occurredAt: fixtureTimestamp(1),
    });
    const rows = await context.db
      .selectFrom("execution.order_events")
      .select(["order_event_id", "payload"])
      .where("order_id", "=", orderId)
      .orderBy("event_ordinal", "asc")
      .execute();
    expect(rows.map((row) => row.order_event_id)).toEqual([withPayload, withoutPayload]);
    expect(rows[0]?.payload).toEqual(GUARDED_DOCUMENT);
    expect(rows[1]?.payload).toBeNull();
  });

  it("definitions.params_schema (unguarded JSON Schema; keyword numbers kept)", async () => {
    const schema = {
      type: "object",
      properties: { ticks: { type: "string", maxLength: 8 }, ratio: { type: "number", maximum: 5 } },
      required: ["ticks"],
    };
    const definitionId = await context.repositories.strategy.createDefinition({
      strategyName: "ser-2-schema",
      codeVersion: "0.1.0",
      paramsSchema: schema,
      stateSchemaVersion: 1,
      decisionContractVersion: 1,
    });
    const stored = await context.db
      .selectFrom("strategy.definitions")
      .select(["params_schema"])
      .where("definition_id", "=", definitionId)
      .executeTakeFirstOrThrow();
    expect(stored.params_schema).toEqual(schema);
  });

  it("configs.parameters (decimal-guarded)", async () => {
    const { configId } = await context.repositories.strategy.createConfig({
      definitionId: chain.definitionId,
      parameters: GUARDED_DOCUMENT,
      parametersHash: hashOf("ser-2-config"),
      validatedAt: fixtureTimestamp(),
      createdBy: "ser-2",
    });
    const stored = await context.db
      .selectFrom("strategy.configs")
      .select(["parameters"])
      .where("config_id", "=", configId)
      .executeTakeFirstOrThrow();
    expect(stored.parameters).toEqual(GUARDED_DOCUMENT);
  });

  it("markets.raw_metadata (unguarded), and its `{}` default", async () => {
    const metadata = { slug: "btc-up", tags: ["crypto", "btc"], volume: 12.5, nested: { active: true, note: null } };
    const register = (conditionId: string, rawMetadata?: typeof metadata) =>
      context.repositories.catalog.registerMarket({
        conditionId,
        questionTitle: `SER-2 ${conditionId}`,
        seriesId: chain.seriesId,
        parameters: {
          tickSize: "0.01",
          minimumOrderSize: "5",
          tradingDelaySeconds: 0,
          negRisk: false,
          lifecycleState: "OPEN",
        },
        tokens: [],
        ...(rawMetadata === undefined ? {} : { rawMetadata }),
        source: "polymarket",
        observedAt: fixtureTimestamp(),
      });
    const withMetadata = await register("ser-2-metadata", metadata);
    const withDefault = await register("ser-2-default");
    const rows = await context.db
      .selectFrom("catalog.markets")
      .select(["market_id", "raw_metadata"])
      .where("market_id", "in", [withMetadata, withDefault])
      .execute();
    expect(rows.find((row) => row.market_id === withMetadata)?.raw_metadata).toEqual(metadata);
    expect(rows.find((row) => row.market_id === withDefault)?.raw_metadata).toEqual({});
  });

  it("dataset_manifests.start_event_identity / end_event_identity / pinned_versions", async () => {
    const epoch = "0190a3e0-0000-7000-8000-000000000042";
    const start = { gatewayEpoch: epoch, ingestSeq: "1", receivedAt: fixtureTimestamp(), datasetRowOrdinal: 0 };
    const end = { gatewayEpoch: epoch, ingestSeq: "9", receivedAt: fixtureTimestamp(9), datasetRowOrdinal: 8 };
    const pins = { feeSnapshotVersion: "fees/2026-08-24", settlementSpecVersions: ["s1", "s2"], note: null };
    const outcome = await context.repositories.datasetCatalog.importDatasetManifest({
      manifestKey: "ds-ser-2",
      gatewayEpoch: epoch,
      manifestSha256: "a".repeat(64),
      normalizerVersion: "polymarket-public/market-channel/v1",
      runSeed: "42",
      startEventIdentity: start,
      endEventIdentity: end,
      pinnedVersions: pins,
      source: "polymarket",
      endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      segmentFormat: "JSONL",
      segments: [
        {
          walSegmentId: `${epoch}-000000`,
          segmentIndex: 0,
          segmentSha256: "b".repeat(64),
          recordCount: 3,
          byteSize: 1600,
          firstIngestSeq: "1",
          lastIngestSeq: "9",
          firstReceivedAt: fixtureTimestamp(),
          lastReceivedAt: fixtureTimestamp(9),
          fileUri: `${epoch}-000000.wal.jsonl`,
        },
      ],
      exclusions: [],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stored = await context.db
      .selectFrom("data.dataset_manifests")
      .select(["start_event_identity", "end_event_identity", "pinned_versions"])
      .where("dataset_manifest_id", "=", outcome.value.datasetManifestId)
      .executeTakeFirstOrThrow();
    expect(stored.start_event_identity).toEqual(start);
    expect(stored.end_event_identity).toEqual(end);
    expect(stored.pinned_versions).toEqual(pins);
  });
});
