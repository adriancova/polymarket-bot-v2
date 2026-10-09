/**
 * `register --new-run <instanceId>` (`C1-HALTS`, NEW-RUN; OPS-03 (a)): a NEW
 * `strategy.runs` row for an instance that is already registered, and the
 * completed document that names it.
 *
 * ## Why
 *
 * Every halt ends the run, and `BOOT-1` refuses to resume a run that holds
 * decisions (the trader has no read path to rebuild one), so every restart
 * needs a new run. Until this mode no tool could make one: the registration
 * command refuses an existing instance or market as a duplicate, and the
 * operator was told to call `startRun` by hand and edit the document.
 *
 * ## What it does, and what it reuses
 *
 * The input is a COMPLETED document — one a registration (or an earlier
 * `--new-run`) wrote, naming the instance's `instanceId`, `runId`, `configId`,
 * `runSeed` and market. In ONE transaction it:
 *
 * 1. reads the instance's `strategy.instances` row (PAPER) for the definition
 *    its runs pin;
 * 2. mints ONE `strategy.runs` row through the same repository call the
 *    registration uses (`startRun`): the same instance, definition, config and
 *    run seed, the operator's `--code-commit`, `RUNNING`, the PAPER cadence;
 * 3. replaces that instance's `runId` in the document — nothing else changes;
 * 4. runs the trader's OWN startup registration check (`BOOT-1`,
 *    `verifyRegisteredRows`) on the result, for that instance and its market,
 *    inside the transaction. The market and instance rows are REUSED only if
 *    they agree with the document exactly as a start requires (condition id,
 *    environment, account, config parameters, run seed, cadence, no decisions
 *    on the new run); anything else is refused and rolled back.
 *
 * `BOOT-1` is unchanged: the trader still refuses a run that holds decisions,
 * and this mode is how an operator gets one that does not. One instance per
 * call: a document with several instances gets one call per instance, each
 * reading the previous call's output.
 *
 * Not in scope (OPS-03 (b), a follow-up): the stream consumer is still keyed
 * by the configuration's `infrastructure.consumerId`, so a new run resumes the
 * previous run's stream position.
 */

import { createStrategyRepository, type PolymarketBotDatabase } from "@polymarket-bot/storage-postgres";
import { PAPER_EVALUATION_CADENCE, parseTraderConfig, type TraderConfig } from "@polymarket-bot/trading-core";

import { verifyRegisteredRows } from "../adapters/postgres-registration.js";
import { STATIC_BRACKET_DEFINITION } from "./registration.js";
import type { TemplateRefusal } from "./template.js";

/** A completed document and the one instance a new run is for. */
export interface NewRunDocument {
  /** The document exactly as parsed from its file. */
  readonly document: Readonly<Record<string, unknown>>;
  /** The trader's own parse of it. */
  readonly config: TraderConfig;
  /** Which list names the instance, and where. */
  readonly list: "instances" | "seriesInstances";
  readonly index: number;
  readonly instanceId: string;
  /** The run the document names now, which the new run replaces. */
  readonly previousRunId: string;
  readonly configId: string;
  readonly runSeed: string;
}

export type NewRunDocumentResult =
  | { readonly ok: true; readonly value: NewRunDocument }
  | { readonly ok: false; readonly refusal: TemplateRefusal };

/** Reads a completed document and finds the instance. TOTAL: never throws; opens nothing. */
export function readNewRunDocument(text: string, instanceId: string): NewRunDocumentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return refuse("REGISTER_TEMPLATE_UNREADABLE", "the document is not JSON", [
      cause instanceof Error ? cause.message : String(cause),
    ]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("REGISTER_TEMPLATE_UNREADABLE", "the document is not a JSON object; it is a completed trader configuration");
  }
  const door = parseTraderConfig(parsed);
  if (!door.ok) {
    return refuse(
      "REGISTER_TEMPLATE_INVALID",
      `the trader's configuration door refused the document (${door.refusal.code}: ${door.refusal.detail})`,
      door.refusal.issues,
    );
  }
  const config = door.config;
  const fixed = config.instances.findIndex((instance) => instance.instanceId === instanceId);
  const series = (config.seriesInstances ?? []).findIndex((instance) => instance.instanceId === instanceId);
  const found =
    fixed >= 0
      ? { list: "instances" as const, index: fixed, instance: config.instances[fixed] }
      : series >= 0
        ? { list: "seriesInstances" as const, index: series, instance: config.seriesInstances?.[series] }
        : undefined;
  if (found?.instance === undefined) {
    return refuse(
      "REGISTER_TEMPLATE_NOT_REGISTRABLE",
      `the document names no instance ${JSON.stringify(instanceId)}; --new-run takes the instanceId of one of ` +
        "its instances (or seriesInstances)",
      [...config.instances, ...(config.seriesInstances ?? [])].map((instance) => `instance ${instance.instanceId}`),
    );
  }
  return {
    ok: true,
    value: {
      document: parsed as Readonly<Record<string, unknown>>,
      config,
      list: found.list,
      index: found.index,
      instanceId,
      previousRunId: found.instance.runId,
      configId: found.instance.configId,
      runSeed: found.instance.runSeed,
    },
  };
}

/** The document with that one instance's `runId` replaced; every other key keeps its place and value. */
export function withNewRunId(input: NewRunDocument, runId: string): Record<string, unknown> {
  const list = input.document[input.list];
  if (!Array.isArray(list)) throw new Error(`the parsed document lost its ${input.list}`);
  return {
    ...input.document,
    [input.list]: list.map((entry: unknown, index) =>
      index === input.index ? { ...(entry as Record<string, unknown>), runId } : entry,
    ),
  };
}

/**
 * The configuration narrowed to ONE instance (and, for a market-bound one, its
 * market), for the registration check: the document's OTHER instances keep
 * their runs, which may hold decisions, and this call answers for the one it
 * changed. Every other field is the configuration's own.
 */
export function configForInstance(config: TraderConfig, instanceId: string): TraderConfig {
  const fixed = config.instances.filter((instance) => instance.instanceId === instanceId);
  const marketIds = new Set(fixed.map((instance) => instance.marketId));
  return {
    ...config,
    markets: config.markets.filter((market) => marketIds.has(market.marketId)),
    instances: fixed,
    seriesInstances: (config.seriesInstances ?? []).filter((instance) => instance.instanceId === instanceId),
  };
}

export type NewRunOutcome =
  | { readonly ok: true; readonly runId: string; readonly document: Record<string, unknown> }
  | { readonly ok: false; readonly refusal: { readonly code: string; readonly detail: string; readonly issues: readonly string[] } };

/**
 * Mints the run and checks the result, on `db` — the ONE transaction's handle.
 * A refusal is returned (the caller rolls back); a database error is THROWN.
 */
export async function mintNewRun(
  db: PolymarketBotDatabase,
  input: NewRunDocument,
  codeCommit: string,
  log: (line: string) => void,
): Promise<NewRunOutcome> {
  const row = await db
    .selectFrom("strategy.instances")
    .select(["instance_id", "definition_id", "environment"])
    .where("instance_id", "=", input.instanceId)
    .executeTakeFirst();
  if (row === undefined || row.environment !== "PAPER") {
    return {
      ok: false,
      refusal: {
        code: "REGISTER_NEW_RUN_NO_INSTANCE",
        detail:
          `strategy.instances holds no PAPER instance ${input.instanceId}, so there is nothing to start a new run ` +
          "of; register the instance first (register without --new-run)",
        issues: row === undefined ? [] : [`the row's environment is ${row.environment}`],
      },
    };
  }
  const runId = await createStrategyRepository(db).startRun({
    instanceId: input.instanceId,
    definitionId: row.definition_id,
    configId: input.configId,
    environment: "PAPER",
    codeCommit,
    stateSchemaVersion: STATIC_BRACKET_DEFINITION.stateSchemaVersion,
    runSeed: input.runSeed,
    evaluationIntervalMs: PAPER_EVALUATION_CADENCE.intervalMs,
    evaluationHeartbeatMs: PAPER_EVALUATION_CADENCE.heartbeatMs,
  });
  log(
    `strategy.runs: started run_id ${runId} for instance ${input.instanceId} (PAPER, RUNNING, run_seed ` +
      `${input.runSeed}, config ${input.configId}, code_commit ${JSON.stringify(codeCommit)}; it replaces run ` +
      `${input.previousRunId} in the document) — not yet committed`,
  );
  const document = withNewRunId(input, runId);
  const reparsed = parseTraderConfig(document);
  if (!reparsed.ok) {
    return {
      ok: false,
      refusal: {
        code: "REGISTER_NEW_RUN_DOCUMENT_REFUSED",
        detail: `the document with the new run was refused by the trader's door (${reparsed.refusal.code}); nothing was committed`,
        issues: reparsed.refusal.issues,
      },
    };
  }
  const verified = await verifyRegisteredRows(db, configForInstance(reparsed.config, input.instanceId));
  if (!verified.ok) {
    return {
      ok: false,
      refusal: {
        code: "REGISTER_NEW_RUN_DISAGREES",
        detail:
          `the trader's own registration check refused the document with the new run (${verified.refusal.code}: ` +
          `${verified.refusal.detail}); the market and instance rows are reused only when they agree with it, so ` +
          "nothing was committed",
        issues: verified.refusal.issues,
      },
    };
  }
  log(
    "registration check (BOOT-1): the market, instance, config and NEW run rows agree with the document — " +
      "not yet committed",
  );
  return { ok: true, runId, document };
}

function refuse(code: TemplateRefusal["code"], detail: string, issues: readonly string[] = []): NewRunDocumentResult {
  return { ok: false, refusal: { code, detail, issues } };
}
