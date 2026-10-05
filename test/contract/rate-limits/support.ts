/**
 * Shared loaders for the WP-310 contract suite. Offline: every file read here
 * is in the repository.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VenueModeDetector } from "../../../packages/oms/src/index.js";
import { RateLimitBudget } from "../../../packages/polymarket-secure/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

export const RATE_LIMIT_SNAPSHOT_PATH = resolve(here, "fixtures/rate-limits-2026-09-30.snapshot.json");
export const RESTRICTED_MODE_SNAPSHOT_PATH = resolve(here, "fixtures/restricted-modes-2026-09-30.snapshot.json");

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function readRepoText(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

/** Whitespace-normalized, as the venue-fact checks compare quotes. */
export function normalized(text: string): string {
  return text.replace(/\s+/gu, " ");
}

/** The documented rate-limit snapshot as a mutable document. */
export function rateLimitSnapshot(): Record<string, unknown> {
  return readJson(RATE_LIMIT_SNAPSHOT_PATH) as Record<string, unknown>;
}

export function documentedBudget(): RateLimitBudget {
  const created = RateLimitBudget.create([rateLimitSnapshot()]);
  if (!created.ok) throw new Error(created.refusal.message);
  return created.value;
}

export function documentedDetector(): VenueModeDetector {
  const created = VenueModeDetector.create([readJson(RESTRICTED_MODE_SNAPSHOT_PATH)]);
  if (!created.ok) throw new Error(created.problems.join("; "));
  return created.value;
}

/** A frozen venue fixture's example payload by name. */
export function venueExample(fixture: string, name: string): Record<string, unknown> {
  const file = readJson(resolve(REPO_ROOT, "test/fixtures/venue", fixture)) as { readonly examples: readonly { readonly name: string; readonly payload: Record<string, unknown> }[] };
  const found = file.examples.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`fixture example ${name} is missing from ${fixture}`);
  return found.payload;
}

/** 2026-10-01T00:00:00Z: an instant after both snapshots take effect. */
export const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
export const SIGNER = "0x00000000000000000000000000000000000000a1";
