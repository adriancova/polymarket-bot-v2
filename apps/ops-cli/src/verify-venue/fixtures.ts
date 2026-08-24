/**
 * WP-000 venue-fixture loading and structural validation.
 *
 * Loads the sanitized venue fixtures frozen under `test/fixtures/venue/` and
 * validates their envelope and payload shapes. Structural validation only:
 * `packages/domain` does not exist yet, so no domain schemas are imported.
 *
 * This module never touches the network, never places orders, and never
 * requires credentials. It reads local fixture files only.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repository root (four levels above this file). */
export const REPO_ROOT: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** Absolute path to the sanitized venue fixture tree. */
export const VENUE_FIXTURE_ROOT: string = join(
  REPO_ROOT,
  "test",
  "fixtures",
  "venue",
);

export interface FixtureExample {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

export interface FixtureFile {
  readonly fixture: string;
  readonly source: string;
  readonly retrieved: string;
  readonly sanitized: true;
  readonly notes: string;
  readonly examples: readonly FixtureExample[];
}

export interface FixtureValidationResult {
  readonly relativePath: string;
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly fixture: FixtureFile | null;
}

const OFFICIAL_SOURCE_PREFIXES = [
  "https://docs.polymarket.com/",
  "https://github.com/Polymarket/",
] as const;

/** Credential-shaped keys that must only ever carry sanitized placeholders. */
const CREDENTIAL_KEYS = ["apiKey", "secret", "passphrase", "api_key"] as const;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSanitizedPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return (
    value === "" ||
    value === ZERO_UUID ||
    value.startsWith("sanitized-") ||
    /^0x0+[0-9a-z]{0,8}$/i.test(value)
  );
}

function scanForCredentials(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      scanForCredentials(entry, `${path}[${index}]`, errors);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      (CREDENTIAL_KEYS as readonly string[]).includes(key) &&
      !isSanitizedPlaceholder(entry)
    ) {
      errors.push(
        `${path}.${key}: credential-shaped field must be a sanitized placeholder`,
      );
    }
    scanForCredentials(entry, `${path}.${key}`, errors);
  }
}

/**
 * Validates the common fixture envelope and, when provided, the payload keys
 * every example in the file must carry.
 */
export function validateFixtureDocument(
  raw: unknown,
  expectedFixtureName: string,
  requiredPayloadKeys: readonly string[],
): { fixture: FixtureFile | null; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { fixture: null, errors: ["document is not a JSON object"] };
  }
  if (raw["fixture"] !== expectedFixtureName) {
    errors.push(
      `fixture name mismatch: expected "${expectedFixtureName}", got ${JSON.stringify(raw["fixture"])}`,
    );
  }
  const source = raw["source"];
  if (
    typeof source !== "string" ||
    !OFFICIAL_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix))
  ) {
    errors.push("source must cite an official Polymarket URL");
  }
  const retrieved = raw["retrieved"];
  if (typeof retrieved !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(retrieved)) {
    errors.push("retrieved must be an ISO date (YYYY-MM-DD)");
  }
  if (raw["sanitized"] !== true) {
    errors.push("sanitized must be exactly true");
  }
  if (typeof raw["notes"] !== "string" || raw["notes"].length === 0) {
    errors.push("notes must be a non-empty string");
  }
  const examples = raw["examples"];
  if (!Array.isArray(examples) || examples.length === 0) {
    errors.push("examples must be a non-empty array");
  } else {
    examples.forEach((example, index) => {
      if (!isRecord(example)) {
        errors.push(`examples[${index}] is not an object`);
        return;
      }
      if (typeof example["name"] !== "string" || example["name"].length === 0) {
        errors.push(`examples[${index}].name must be a non-empty string`);
      }
      const payload = example["payload"];
      if (!isRecord(payload)) {
        errors.push(`examples[${index}].payload must be an object`);
        return;
      }
      for (const key of requiredPayloadKeys) {
        if (!(key in payload)) {
          errors.push(
            `examples[${index}].payload missing required key "${key}"`,
          );
        }
      }
    });
  }
  scanForCredentials(raw, "$", errors);
  if (errors.length > 0) {
    return { fixture: null, errors };
  }
  return { fixture: raw as unknown as FixtureFile, errors };
}

/** Loads and validates a single fixture file relative to the fixture root. */
export function loadFixture(
  relativePath: string,
  requiredPayloadKeys: readonly string[],
): FixtureValidationResult {
  const absolutePath = join(VENUE_FIXTURE_ROOT, relativePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      relativePath,
      ok: false,
      errors: [`failed to read/parse: ${message}`],
      fixture: null,
    };
  }
  const expectedName = relativePath.replace(/\.json$/, "");
  const { fixture, errors } = validateFixtureDocument(
    raw,
    expectedName,
    requiredPayloadKeys,
  );
  return { relativePath, ok: errors.length === 0, errors, fixture };
}
