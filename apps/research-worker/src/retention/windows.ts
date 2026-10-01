/**
 * The market windows and operator pins the expiry decision reads
 * (ADR-028 Decisions 2.3, 2.5 and 3).
 *
 * ## Where windows come from
 *
 * ADR-028 Decision 2.3: "A trader is responsible when the host configuration
 * names the market for a trader, or a trader run admitted the window
 * (ADR-030)." Neither the host configuration (`HOST-1`) nor admission
 * (`ROLLOVER-1`) exists yet, so — as the incident windows already are
 * (`incident-windows.ts`) — the registry is an operator-supplied JSON file,
 * and this module says so rather than pretending a database is the source.
 * Each entry states its market, its window, and who is responsible for it.
 *
 * Absence fails closed, twice over: a sealed segment whose frames name a
 * Polymarket token or condition no registry entry names is **unclassified**
 * and never expires (`plan.ts`), and a registered window that is not yet
 * classified holds every segment it could overlap.
 *
 * ## Operator pins
 *
 * ADR-028 Decision 3.1/3.5: "An operator can also pin any window"; it lasts
 * "until the operator removes it". Decision 2.5: no segment an operator pin
 * covers may expire. They are read from their own file, so removing one is an
 * operator's edit of that file, never a side effect.
 */

import { readFile } from "node:fs/promises";

import { epochMsOf } from "../research-tier/sampler.js";

/** Who is responsible for a window (ADR-028 Decision 2.3). */
export type WindowResponsibility =
  | { readonly kind: "trader"; readonly instanceIds: readonly string[] }
  | { readonly kind: "gateway-only" };

/** One market window. */
export type MarketWindow = {
  readonly windowId: string;
  /** The internal market id the trader's rows carry (`catalog.markets.market_id`). */
  readonly marketId: string;
  readonly conditionId: string;
  readonly tokenIds: readonly string[];
  /**
   * The Gamma market id the gateway's lifecycle feed polls for this market,
   * when it polls one. A segment whose polls name an unregistered Gamma id is
   * unclassified, as one naming an unregistered token is.
   */
  readonly gammaMarketId: string | null;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /**
   * The earliest instant a responsible trader could have acted on the market
   * (its admission, or the market's open for orders). Until the window is
   * classified, every segment from here (less the lead-in) to the window's end
   * is held, because a decision in that span could widen the window's pin
   * (Decision 3.4). REQUIRED for a trader-responsible window — a trader can
   * act before the window opens (H1's trader evaluated each market from about
   * 14 minutes before its start), so no default would be safe; a gateway-only
   * window defaults it to the window's start.
   */
  readonly responsibleFromMs: number;
  readonly responsibility: WindowResponsibility;
};

/** One operator pin. */
export type OperatorPin = {
  readonly pinId: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly reason: string;
};

export class WindowRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowRegistryError";
  }
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WindowRegistryError(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WindowRegistryError(`${where} must be a non-empty string`);
  }
  return value;
}

function instant(value: unknown, where: string): number {
  const raw = text(value, where);
  try {
    return epochMsOf(raw);
  } catch {
    throw new WindowRegistryError(`${where} must be an ISO-8601 instant`);
  }
}

/** The registry file's document version. */
export const WINDOW_REGISTRY_VERSION = 1;

/** Parse a window registry document. */
export function parseWindowRegistry(value: unknown): readonly MarketWindow[] {
  const root = object(value, "window registry");
  if (root["windowRegistryVersion"] !== WINDOW_REGISTRY_VERSION) {
    throw new WindowRegistryError(`window registry must declare windowRegistryVersion ${String(WINDOW_REGISTRY_VERSION)}`);
  }
  const entries = root["windows"];
  if (!Array.isArray(entries)) throw new WindowRegistryError("window registry windows must be an array");
  const seen = new Set<string>();
  return entries.map((raw, index) => {
    const where = `windows[${String(index)}]`;
    const entry = object(raw, where);
    const windowId = text(entry["windowId"], `${where}.windowId`);
    // It names an object-key prefix (`pins/window-<windowId>/...`).
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(windowId)) {
      throw new WindowRegistryError(`${where}.windowId must be a short identifier`);
    }
    if (seen.has(windowId)) throw new WindowRegistryError(`${where}.windowId ${windowId} is listed twice`);
    seen.add(windowId);
    const tokenIds = entry["tokenIds"];
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
      throw new WindowRegistryError(`${where}.tokenIds must be a non-empty array`);
    }
    const windowStartMs = instant(entry["windowStart"], `${where}.windowStart`);
    const windowEndMs = instant(entry["windowEnd"], `${where}.windowEnd`);
    if (windowEndMs <= windowStartMs) throw new WindowRegistryError(`${where} ends before it starts`);
    const responsibilityRaw = object(entry["responsibility"], `${where}.responsibility`);
    if (responsibilityRaw["kind"] === "trader" && entry["responsibleFrom"] === undefined) {
      throw new WindowRegistryError(
        `${where}.responsibleFrom is required for a trader-responsible window: a trader can act before the window opens`,
      );
    }
    const responsibleFromMs =
      entry["responsibleFrom"] === undefined ? windowStartMs : instant(entry["responsibleFrom"], `${where}.responsibleFrom`);
    if (responsibleFromMs > windowStartMs) {
      throw new WindowRegistryError(`${where}.responsibleFrom must not be after windowStart`);
    }
    let responsibility: WindowResponsibility;
    if (responsibilityRaw["kind"] === "gateway-only") {
      responsibility = { kind: "gateway-only" };
    } else if (responsibilityRaw["kind"] === "trader") {
      const instanceIds = responsibilityRaw["instanceIds"];
      if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
        throw new WindowRegistryError(`${where}.responsibility.instanceIds must be a non-empty array`);
      }
      responsibility = {
        kind: "trader",
        instanceIds: instanceIds.map((id, idIndex) => text(id, `${where}.responsibility.instanceIds[${String(idIndex)}]`)),
      };
    } else {
      throw new WindowRegistryError(`${where}.responsibility.kind must be trader or gateway-only`);
    }
    return {
      windowId,
      marketId: text(entry["marketId"], `${where}.marketId`),
      conditionId: text(entry["conditionId"], `${where}.conditionId`),
      gammaMarketId: entry["gammaMarketId"] === undefined ? null : text(entry["gammaMarketId"], `${where}.gammaMarketId`),
      tokenIds: tokenIds.map((token, tokenIndex) => text(token, `${where}.tokenIds[${String(tokenIndex)}]`)),
      windowStartMs,
      windowEndMs,
      responsibleFromMs,
      responsibility,
    };
  });
}

/** The operator pin file's document version. */
export const OPERATOR_PIN_VERSION = 1;

/** Parse an operator pin document. */
export function parseOperatorPins(value: unknown): readonly OperatorPin[] {
  const root = object(value, "operator pins");
  if (root["operatorPinVersion"] !== OPERATOR_PIN_VERSION) {
    throw new WindowRegistryError(`operator pins must declare operatorPinVersion ${String(OPERATOR_PIN_VERSION)}`);
  }
  const pins = root["pins"];
  if (!Array.isArray(pins)) throw new WindowRegistryError("operator pins must carry a pins array");
  const seen = new Set<string>();
  return pins.map((raw, index) => {
    const where = `pins[${String(index)}]`;
    const entry = object(raw, where);
    const pinId = text(entry["pinId"], `${where}.pinId`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(pinId)) {
      throw new WindowRegistryError(`${where}.pinId must be a short identifier`);
    }
    if (seen.has(pinId)) throw new WindowRegistryError(`${where}.pinId ${pinId} is listed twice`);
    seen.add(pinId);
    const fromMs = instant(entry["from"], `${where}.from`);
    const toMs = instant(entry["to"], `${where}.to`);
    if (toMs < fromMs) throw new WindowRegistryError(`${where} ends before it starts`);
    return { pinId, fromMs, toMs, reason: text(entry["reason"], `${where}.reason`) };
  });
}

async function readJson(path: string, what: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new WindowRegistryError(`${what} ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new WindowRegistryError(`${what} ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Load the window registry. `null` means none is configured: no window is known. */
export async function loadWindowRegistry(path: string | null): Promise<readonly MarketWindow[]> {
  return path === null ? [] : parseWindowRegistry(await readJson(path, "window registry"));
}

/** Load operator pins. `null` means none is configured. */
export async function loadOperatorPins(path: string | null): Promise<readonly OperatorPin[]> {
  return path === null ? [] : parseOperatorPins(await readJson(path, "operator pin file"));
}
