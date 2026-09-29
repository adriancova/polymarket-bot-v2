/**
 * The registration command's INPUT: the trader configuration document itself,
 * as a TEMPLATE (`REGISTER-1`).
 *
 * ## Why the trader's own document, and not a second input format
 *
 * The rows the trader's startup check (`adapters/postgres-registration.ts`)
 * compares against are facts the trader document already states — the
 * market's `conditionId`, the instance's `runSeed`, `accounting.accountRef`,
 * the strategy `params`. Registering them FROM that document, and writing the
 * same document back with the minted identities filled in, makes "the rows
 * and the document agree" true by construction instead of by an operator
 * copying values between two files. The facts the document does NOT carry
 * (a question title, the venue's `negRisk`, the outcome labels, a code commit,
 * an instance name, …) are the command's flags; the trader schema is strict,
 * so they cannot ride inside the document.
 *
 * A template is the document with the FIVE minted identities absent —
 * `markets[0].marketId`, `instances[0].instanceId`, `.runId`, `.configId` and
 * `.marketId` — and exactly one market and one instance. A document that names
 * any of them is refused: it is either a completed document (a re-run) or a
 * hand-edited one whose ids nothing minted.
 *
 * ## Validated before any connection, by the trader's own doors
 *
 * 1. The template, with PLACEHOLDER identities (fresh UUIDv7s that name no row),
 *    goes through `parseTraderConfig` — the door `startup()` uses.
 * 2. Then through a DRY ASSEMBLY in memory: `buildSimulatedVenue` +
 *    `createPaperTrader` over an `InMemoryTraderStore`, the same composition
 *    `assembleDurableTrader` performs after its registration check. That runs
 *    the safety check again, `parseRiskPolicy`, `parseAllocatorCaps`, the
 *    lifecycle-instant normalisation and the STRATEGY's own
 *    `validateStaticBracketParams` — so a document the trader would refuse at
 *    startup is refused here, before an immutable `strategy.configs` row could
 *    record it. No I/O, no timer, nothing kept.
 *
 * ## The parameters, canonically
 *
 * `strategy.configs.parameters` is decimal-guarded: `assertDecimalSafeJson`
 * refuses a JavaScript number at ANY depth (§6 invariant 1), and the Static
 * Bracket's §13.2 document carries integers (`version`, `*_ms`, `*_seconds`,
 * `maximum_entries_per_market`). The stored document is therefore the
 * instance's `params` EXACTLY as the trader document states them, with each
 * number rendered as its decimal string — the rendering `BOOT-1`'s hand
 * registration (`test/integration/paper-trader/support/registration.ts`)
 * uses, so a row this command writes and a row that registration writes for
 * the same document are the same row (pinned). A number that is not a safe
 * integer has no exact decimal string (the document's text was already
 * rounded by `JSON.parse`), and is refused rather than rendered.
 * `parameters_hash` is the sha256 of the exact text the column receives.
 */

import { createHash } from "node:crypto";

import {
  encodeJsonbText,
  uuidV7,
  type DecimalSafeJsonValue,
} from "@polymarket-bot/storage-postgres";
import {
  InMemoryTraderStore,
  buildSimulatedVenue,
  createPaperTrader,
  formatStrictUtc,
  parseTraderConfig,
  type Clock,
  type TraderConfig,
} from "@polymarket-bot/trading-core";

/** A refusal of the input document, with every problem found. */
export interface TemplateRefusal {
  readonly code:
    /** The file is not a JSON object, or its markets/instances are not one each. */
    | "REGISTER_TEMPLATE_UNREADABLE"
    /** The template names an identity only the registration may mint. */
    | "REGISTER_TEMPLATE_HAS_IDENTITIES"
    /** The trader's own configuration door refused the document. */
    | "REGISTER_TEMPLATE_INVALID"
    /** The trader's own composition root refused the document, in memory. */
    | "REGISTER_TEMPLATE_REFUSED_BY_TRADER"
    /** The document is valid for the trader but cannot be registered as stated. */
    | "REGISTER_TEMPLATE_NOT_REGISTRABLE";
  readonly detail: string;
  readonly issues: readonly string[];
}

/** The five identities the registration mints and the completed document names. */
export interface DocumentIdentities {
  readonly marketId: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly configId: string;
}

/** An accepted template. */
export interface Template {
  /** The template exactly as parsed from its file, identities absent. */
  readonly document: Readonly<Record<string, unknown>>;
  /** Its one market and one instance, as parsed. */
  readonly market: Readonly<Record<string, unknown>>;
  readonly instance: Readonly<Record<string, unknown>>;
  /** The trader's own parse of the template (placeholder identities). */
  readonly config: TraderConfig;
  /** The canonical `strategy.configs.parameters` text and its sha256. */
  readonly parametersText: string;
  readonly parametersHash: string;
}

export type TemplateResult =
  | { readonly ok: true; readonly template: Template }
  | { readonly ok: false; readonly refusal: TemplateRefusal };

const MARKET_IDENTITY_FIELDS = ["marketId"] as const;
const INSTANCE_IDENTITY_FIELDS = ["instanceId", "runId", "configId", "marketId"] as const;

/**
 * Reads a template from its text. TOTAL: never throws. Runs the trader's
 * configuration door and its composition root, in memory; opens nothing.
 */
export function readTemplate(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
  nowMs: () => number,
): TemplateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return refuse("REGISTER_TEMPLATE_UNREADABLE", "the template is not JSON", [describe(cause)]);
  }
  if (!isRecord(parsed)) {
    return refuse(
      "REGISTER_TEMPLATE_UNREADABLE",
      "the template is not a JSON object; it is the trader configuration document",
    );
  }
  const markets = parsed["markets"];
  const instances = parsed["instances"];
  const shape: string[] = [];
  if (!Array.isArray(markets) || markets.length !== 1 || !isRecord(markets[0])) {
    shape.push("markets: must be an array holding exactly one market object");
  }
  if (!Array.isArray(instances) || instances.length !== 1 || !isRecord(instances[0])) {
    shape.push("instances: must be an array holding exactly one instance object");
  }
  const market = Array.isArray(markets) ? markets[0] : undefined;
  const instance = Array.isArray(instances) ? instances[0] : undefined;
  if (shape.length > 0 || !isRecord(market) || !isRecord(instance)) {
    return refuse(
      "REGISTER_TEMPLATE_UNREADABLE",
      "this command registers ONE market and ONE instance per run; register a document with " +
        "more than one of either one pair at a time",
      shape,
    );
  }

  const named = [
    ...MARKET_IDENTITY_FIELDS.filter((field) => Object.hasOwn(market, field)).map(
      (field) => `markets[0].${field}`,
    ),
    ...INSTANCE_IDENTITY_FIELDS.filter((field) => Object.hasOwn(instance, field)).map(
      (field) => `instances[0].${field}`,
    ),
  ];
  if (named.length > 0) {
    return refuse(
      "REGISTER_TEMPLATE_HAS_IDENTITIES",
      "the template names identities only the registration mints. A completed document from an " +
        "earlier registration is not a template (re-registering it is refused anyway); remove " +
        "these fields and the command fills them with the ids the repositories mint",
      named.map((field) => `${field} is present`),
    );
  }

  // The trader's door, on the template with placeholder identities.
  const placeholders: DocumentIdentities = {
    marketId: uuidV7(nowMs()),
    instanceId: uuidV7(nowMs()),
    runId: uuidV7(nowMs()),
    configId: uuidV7(nowMs()),
  };
  const placeholder = completeDocument(parsed, market, instance, placeholders);
  const door = parseTraderConfig(placeholder);
  if (!door.ok) {
    return refuse(
      "REGISTER_TEMPLATE_INVALID",
      `the trader's configuration door refused the template (${door.refusal.code}: ` +
        `${door.refusal.detail}); the placeholder identities it was checked with name no row`,
      door.refusal.issues,
    );
  }
  const config = door.config;
  const configuredMarket = config.markets[0];
  const configuredInstance = config.instances[0];
  if (configuredMarket === undefined || configuredInstance === undefined) {
    return refuse("REGISTER_TEMPLATE_UNREADABLE", "the parsed configuration lost its market or instance");
  }

  const registrable: string[] = [];
  if (configuredMarket.parametersVersion !== 1) {
    registrable.push(
      `markets[0].parametersVersion is ${String(configuredMarket.parametersVersion)}: a newly ` +
        "registered market's parameter history starts at version 1 (registerMarket), so a " +
        "document stating another version would disagree with the row it names",
    );
  }
  const parameters = canonicalParameters(configuredInstance.params);
  if (!parameters.ok) registrable.push(...parameters.problems);
  if (registrable.length > 0 || !parameters.ok) {
    return refuse(
      "REGISTER_TEMPLATE_NOT_REGISTRABLE",
      "the document is not registrable as it states itself",
      registrable,
    );
  }

  const dry = dryAssemble(placeholder, env, nowMs);
  if (!dry.ok) return { ok: false, refusal: dry.refusal };

  return {
    ok: true,
    template: {
      document: parsed,
      market,
      instance,
      config,
      parametersText: parameters.text,
      parametersHash: parameters.hash,
    },
  };
}

/**
 * The template with the identities filled in: each market and instance object
 * gets them FIRST, and every other key keeps its place and its value.
 */
export function completeDocument(
  document: Readonly<Record<string, unknown>>,
  market: Readonly<Record<string, unknown>>,
  instance: Readonly<Record<string, unknown>>,
  identities: DocumentIdentities,
): Record<string, unknown> {
  return {
    ...document,
    markets: [{ marketId: identities.marketId, ...market }],
    instances: [
      {
        instanceId: identities.instanceId,
        runId: identities.runId,
        configId: identities.configId,
        marketId: identities.marketId,
        ...instance,
      },
    ],
  };
}

/**
 * The document through the trader's own composition root, in memory:
 * `buildSimulatedVenue` + `createPaperTrader` over an `InMemoryTraderStore`.
 * Nothing is kept; the result is only the answer.
 */
export function dryAssemble(
  document: unknown,
  env: Readonly<Record<string, string | undefined>>,
  nowMs: () => number,
): { readonly ok: true } | { readonly ok: false; readonly refusal: TemplateRefusal } {
  const door = parseTraderConfig(document);
  if (!door.ok) {
    return refuse(
      "REGISTER_TEMPLATE_INVALID",
      `the trader's configuration door refused the document (${door.refusal.code}: ` +
        `${door.refusal.detail})`,
      door.refusal.issues,
    );
  }
  const clock: Clock = {
    now: () => formatStrictUtc(nowMs()),
    monotonicNs: () => process.hrtime.bigint(),
  };
  const built = buildSimulatedVenue({ clock, settings: door.config.simulation });
  if (!built.ok) {
    return refuse(
      "REGISTER_TEMPLATE_REFUSED_BY_TRADER",
      "the trader's simulated venue refused the configured fee snapshot, so the trader would " +
        "refuse to start on this document",
      [`${built.refusal.code}: ${built.refusal.message}`],
    );
  }
  const created = createPaperTrader({
    env,
    config: document,
    clock,
    venue: built.venue,
    store: new InMemoryTraderStore(),
    idNamespace: "register-dry-assembly",
  });
  if (!created.ok) {
    return refuse(
      "REGISTER_TEMPLATE_REFUSED_BY_TRADER",
      `the trader's composition root refused the document in memory (${created.refusal.code}: ` +
        `${created.refusal.detail}), so the trader would refuse to start on it`,
      created.refusal.issues,
    );
  }
  return { ok: true };
}

export type CanonicalParameters =
  | {
      readonly ok: true;
      readonly value: { readonly [key: string]: DecimalSafeJsonValue };
      /** The exact text `strategy.configs.parameters` receives. */
      readonly text: string;
      /** sha256 hex of {@link text}'s UTF-8 bytes. */
      readonly hash: string;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The instance's `params` as `strategy.configs.parameters` stores them: the
 * same document, key order kept, with every number rendered as its decimal
 * string. See the module header.
 */
export function canonicalParameters(params: unknown): CanonicalParameters {
  const problems: string[] = [];
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { ok: false, problems: ["instances[0].params: must be a JSON object"] };
  }
  // `Object.fromEntries` defines OWN data properties, so a key spelled
  // `__proto__` stays a key and never becomes the object's prototype.
  const value: { readonly [key: string]: DecimalSafeJsonValue } = Object.fromEntries(
    Object.entries(params).map(([key, inner]) => [
      key,
      rendered(inner, `instances[0].params.${key}`, problems),
    ]),
  );
  if (problems.length > 0) return { ok: false, problems };
  const text = encodeJsonbText(value, "configs.parameters");
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return { ok: true, value, text, hash };
}

function rendered(value: unknown, path: string, problems: string[]): DecimalSafeJsonValue {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return String(value);
    problems.push(
      `${path}: the number ${String(value)} is not a safe integer, so no decimal string states ` +
        "it exactly (strategy.configs.parameters holds numbers as decimal strings, §6 invariant 1); " +
        "state an economic value as a decimal STRING in the document",
    );
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((element, index) => rendered(element, `${path}[${String(index)}]`, problems));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, rendered(inner, `${path}.${key}`, problems)]),
    );
  }
  problems.push(`${path}: a ${typeof value} is not a JSON value`);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(
  code: TemplateRefusal["code"],
  detail: string,
  issues: readonly string[] = [],
): { readonly ok: false; readonly refusal: TemplateRefusal } {
  return { ok: false, refusal: { code, detail, issues } };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
