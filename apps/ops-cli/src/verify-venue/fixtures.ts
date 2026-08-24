/**
 * WP-000 venue-fixture loading and structural validation.
 *
 * Loads the sanitized venue fixtures frozen under `test/fixtures/venue/` and
 * validates their envelope and payload shapes against source-specific
 * schemas (types, enums, optionality). Structural validation only:
 * `packages/domain` does not exist yet, so no domain schemas are imported.
 *
 * This module never touches the network, never places orders, and never
 * requires credentials. It reads local fixture files only.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

export type FieldType =
  | "string"
  | "decimal-string"
  | "number"
  | "boolean"
  | "object"
  | "array";

export interface FieldSpec {
  readonly type: FieldType;
  readonly enum?: readonly string[];
  readonly optional?: boolean;
}

/** Source-specific payload schema. Unknown extra keys are permitted. */
export type PayloadSchema = Readonly<Record<string, FieldSpec>>;

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

/**
 * Credential/secret-shaped keys that must only ever carry sanitized
 * placeholders. Covers API keys/secrets/passphrases, private keys, signature
 * and signed-payload material, mnemonic/seed phrases, authorization headers,
 * and the user-stream `owner` field (which carries the CLOB API key).
 */
const CREDENTIAL_KEYS: readonly string[] = [
  "apiKey",
  "api_key",
  "apiSecret",
  "api_secret",
  "secret",
  "clientSecret",
  "client_secret",
  "passphrase",
  "privateKey",
  "private_key",
  "signature",
  "signatures",
  "signedOrder",
  "signed_order",
  "signedPayload",
  "signed_payload",
  "mnemonic",
  "seed",
  "seedPhrase",
  "seed_phrase",
  "authorization",
  "Authorization",
  "owner",
];

const ZERO_UUID_RE = /^0{8}-0{4}-0{4}-0{4}-0{8}[0-9a-z]{0,4}$/i;

export function isSanitizedPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return (
    value === "" ||
    ZERO_UUID_RE.test(value) ||
    value.startsWith("sanitized-") ||
    /^0x0+[0-9a-z]{0,8}$/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (CREDENTIAL_KEYS.includes(key) && !isSanitizedPlaceholder(entry)) {
      errors.push(
        `${path}.${key}: credential/secret-shaped field must be a sanitized placeholder`,
      );
    }
    scanForCredentials(entry, `${path}.${key}`, errors);
  }
}

const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

function validateField(
  value: unknown,
  spec: FieldSpec,
  path: string,
  errors: string[],
): void {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") {
        errors.push(`${path}: expected string, got ${typeof value}`);
        return;
      }
      break;
    case "decimal-string":
      if (typeof value !== "string" || !DECIMAL_STRING_RE.test(value)) {
        errors.push(`${path}: expected canonical decimal string`);
        return;
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${path}: expected finite number, got ${typeof value}`);
        return;
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(`${path}: expected boolean, got ${typeof value}`);
        return;
      }
      break;
    case "object":
      if (!isRecord(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return;
      }
      break;
  }
  if (spec.enum !== undefined && typeof value === "string") {
    if (!spec.enum.includes(value)) {
      errors.push(
        `${path}: value ${JSON.stringify(value)} not in enum [${spec.enum.join(", ")}]`,
      );
    }
  }
}

/**
 * Validates the common fixture envelope and each example payload against a
 * source-specific schema (types, enums, optionality).
 */
export function validateFixtureDocument(
  raw: unknown,
  expectedFixtureName: string,
  schema: PayloadSchema,
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
      for (const [key, spec] of Object.entries(schema)) {
        const path = `examples[${index}].payload.${key}`;
        if (!(key in payload)) {
          if (spec.optional !== true) {
            errors.push(`${path}: missing required key`);
          }
          continue;
        }
        validateField(payload[key], spec, path, errors);
      }
    });
  }
  scanForCredentials(raw, "$", errors);
  if (errors.length > 0) {
    return { fixture: null, errors };
  }
  return { fixture: raw as unknown as FixtureFile, errors };
}

/**
 * Loads and validates a single fixture file relative to the fixture root.
 * Rejects any path that escapes the fixture tree (path traversal).
 */
export function loadFixture(
  relativePath: string,
  schema: PayloadSchema,
): FixtureValidationResult {
  const absolutePath = resolve(VENUE_FIXTURE_ROOT, relativePath);
  const rel = relative(VENUE_FIXTURE_ROOT, absolutePath);
  if (rel.startsWith("..") || rel.includes("..")) {
    return {
      relativePath,
      ok: false,
      errors: ["path escapes the venue fixture root (traversal rejected)"],
      fixture: null,
    };
  }
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
    schema,
  );
  return { relativePath, ok: errors.length === 0, errors, fixture };
}
