/**
 * Loader for the frozen sanitized venue fixtures.
 *
 * The fixtures under `test/fixtures/venue/` are `WP-000`'s frozen,
 * documentation-derived snapshot (`test/fixtures/venue/README.md`). They are
 * read-only here: this suite proves the adapter parses them, and it never
 * edits them.
 *
 * The loader deliberately fails when a fixture file is missing or carries no
 * examples. A contract suite that silently passed with nothing to check would
 * be worse than no suite at all — that is exactly how "all fixtures parse"
 * becomes vacuous.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/** The envelope every `WP-000` fixture file carries. */
export interface VenueFixtureFile {
  readonly fixture: string;
  readonly source: string;
  readonly retrieved: string;
  readonly sanitized: boolean;
  readonly notes?: string;
  readonly examples: readonly VenueFixtureExample[];
}

export interface VenueFixtureExample {
  readonly name: string;
  readonly payload: unknown;
}

/** Every market-WebSocket fixture file frozen by `WP-000`. */
export const MARKET_WS_FIXTURE_FILES = [
  "book-snapshot",
  "price-change",
  "tick-size-change",
  "last-trade-price",
  "best-bid-ask",
  "lifecycle",
] as const;

export type MarketWsFixtureName = (typeof MARKET_WS_FIXTURE_FILES)[number];

export function loadMarketWsFixture(name: MarketWsFixtureName): VenueFixtureFile {
  const path = resolve(repoRoot, "test/fixtures/venue/market-ws", `${name}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as VenueFixtureFile;
  if (!Array.isArray(parsed.examples) || parsed.examples.length === 0) {
    throw new Error(`fixture ${name} carries no examples; the suite would pass vacuously`);
  }
  return parsed;
}

/** Every market-WebSocket example, flattened, with its file for reporting. */
export function loadAllMarketWsExamples(): readonly {
  readonly file: MarketWsFixtureName;
  readonly name: string;
  readonly payload: unknown;
}[] {
  return MARKET_WS_FIXTURE_FILES.flatMap((file) =>
    loadMarketWsFixture(file).examples.map((example) => ({
      file,
      name: example.name,
      payload: example.payload,
    })),
  );
}

/** A locally-owned fixture under this suite's own directory. */
export function loadLocalFixture(relativePath: string): VenueFixtureFile {
  const path = resolve(here, relativePath);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as VenueFixtureFile;
  if (!Array.isArray(parsed.examples) || parsed.examples.length === 0) {
    throw new Error(`fixture ${relativePath} carries no examples`);
  }
  return parsed;
}
