/**
 * Loader for the RTDS fixtures.
 *
 * Two provenances, kept apart on purpose:
 *
 * 1. **`test/fixtures/venue/rtds/twap-update.json`** — `WP-000`'s frozen,
 *    sanitized, documentation-derived snapshot. Read-only here: this suite
 *    proves the adapter parses it, and never edits it.
 * 2. **`./fixtures/*.json`** — fixtures this work package owns, each labelled
 *    with how it was derived (`provenance`) so a reader can tell a documented
 *    example from a deliberately malformed probe. None of them invents venue
 *    behaviour: every field shape comes from the official page, and the
 *    malformed ones are documented examples with one field broken on purpose.
 *
 * The loader fails when a file is missing or carries no examples. A contract
 * suite that silently passed with nothing to check would be worse than no suite
 * at all — that is exactly how "all fixtures parse" becomes vacuous.
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

/** A fixture this work package owns, with its derivation recorded. */
export interface LocalFixtureFile extends VenueFixtureFile {
  /** How each example was derived. Never "observed on a live socket". */
  readonly provenance: string;
  readonly examples: readonly LocalFixtureExample[];
}

export interface LocalFixtureExample extends VenueFixtureExample {
  /** What this example is for, in one line. */
  readonly purpose: string;
  /** The problem code the adapter must report, for the malformed examples. */
  readonly expectedProblemCode?: string;
}

function read<T extends VenueFixtureFile>(path: string, label: string): T {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as T;
  if (!Array.isArray(parsed.examples) || parsed.examples.length === 0) {
    throw new Error(`fixture ${label} carries no examples; the suite would pass vacuously`);
  }
  return parsed;
}

/** The frozen `WP-000` RTDS fixture. */
export function loadFrozenTwapFixture(): VenueFixtureFile {
  return read(resolve(repoRoot, "test/fixtures/venue/rtds/twap-update.json"), "rtds/twap-update");
}

/** One example of the frozen fixture, by name. */
export function frozenExample(name: string): unknown {
  const example = loadFrozenTwapFixture().examples.find((entry) => entry.name === name);
  if (example === undefined) {
    throw new Error(`the frozen RTDS fixture has no example named "${name}"`);
  }
  return example.payload;
}

/** A fixture owned by this suite. */
export function loadLocalFixture(relativePath: string): LocalFixtureFile {
  return read<LocalFixtureFile>(resolve(here, relativePath), relativePath);
}
