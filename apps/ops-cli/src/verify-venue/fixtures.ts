/**
 * WP-000 venue-fixture loading and structural validation.
 *
 * Loads the sanitized venue fixtures frozen under `test/fixtures/venue/` and
 * validates their envelope and payload shapes against source-specific,
 * recursively nested schemas (types, enums, optionality, nullability,
 * canonical decimal form, map-valued objects, unions, and strict key sets).
 * Heterogeneous fixtures are validated through discriminated variants so that
 * no example can pass by making every field optional.
 *
 * Optionality and nullability are SEPARATE axes and are never conflated:
 * `optional` means the key may be ABSENT, `nullable` means the value may be
 * `null`. An `optional` field that receives an explicit `null` is an error
 * unless the same spec also declares `nullable`, and every `nullable` in the
 * catalog must cite an official published type that documents `| null`
 * (report §17).
 *
 * Structural validation only: `packages/domain` does not exist yet, so no
 * domain schemas are imported. The schemas here are contract-shaped stand-ins
 * frozen against the official SDK raw schemas at the pinned reference commit
 * (see `checks.ts`).
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

/**
 * Field kinds.
 *
 * The kinds whose names start with `empty-or-` model the official SDK's
 * `OptionalDecimalStringSchema`
 * (`z.preprocess(emptyStringToNull, DecimalStringSchema.nullish())`), which
 * accepts the wire empty string for absent optional decimals. `digit-string`
 * models the SDK's epoch schemas (`z.string().regex(/^\d+$/)`). `integer`
 * models `z.number().int()`. See `checks.ts` for the pinned source commit.
 */
export type FieldType =
  | "string"
  | "decimal-string"
  | "price-string"
  | "empty-or-decimal-string"
  | "empty-or-price-string"
  | "digit-string"
  | "hex-string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "union"
  | "unknown";

export interface FieldSpec {
  readonly type: FieldType;
  readonly enum?: readonly string[];
  /**
   * KEY ABSENCE ONLY: the key may be missing (or explicitly `undefined`).
   * A present key is still validated.
   *
   * `optional` does NOT permit an explicit `null`. Round-5 review finding
   * HIGH: an earlier revision accepted `null` whenever EITHER `nullable` or
   * `optional` was true, which silently admitted `filters: null`,
   * `transactionsHashes: null`, `tradeIDs: null`, and `hash: null` — none of
   * which any official source documents, and two of which the SDK's own
   * `.default([])` rejects. Null is now accepted only where `nullable: true`
   * is declared, and every such declaration must cite an official published
   * type that says `| null` (see report §17).
   */
  readonly optional?: boolean;
  /**
   * The value may be `null`. Declare it ONLY for a field whose official
   * published type documents `null` (for example
   * `endDate: IsoCalendarDateString | null`). Combine with `optional` to model
   * a documented `?: T | null` (SDK `.nullish()`); use alone for
   * SDK `.nullable()`, where the key must be present but may be null.
   */
  readonly nullable?: boolean;
  /** Accepted total string lengths for `type: "hex-string"` (incl. `0x`). */
  readonly hexLengths?: readonly number[];
  /** Nested field map for `type: "object"` values. */
  readonly fields?: PayloadSchema;
  /**
   * Spec applied to every key of a map-shaped object that is not named in
   * `fields`. Use for heterogeneous maps (fee tables, header bags, endpoint
   * limit maps, contract-address maps).
   */
  readonly values?: FieldSpec;
  /**
   * Reject keys that are not named in `fields`. Used for schemas frozen
   * against an official SDK definition so that an omitted SDK field cannot
   * hide behind permissive unknown-key acceptance.
   */
  readonly strict?: boolean;
  /** Element spec for `type: "array"` values (validated recursively). */
  readonly items?: FieldSpec;
  /** Alternatives for `type: "union"`; the value must satisfy at least one. */
  readonly oneOf?: readonly FieldSpec[];
}

/** Source-specific payload field map. */
export type PayloadSchema = Readonly<Record<string, FieldSpec>>;

/** Schema for a single object shape. */
export interface ObjectSpec {
  readonly fields?: PayloadSchema;
  readonly values?: FieldSpec;
  readonly strict?: boolean;
}

/**
 * Discriminated schema for fixtures whose examples are heterogeneous.
 *
 * `discriminant: "example-name"` keys variants on `examples[].name` (used for
 * configuration snapshots that share no wire discriminator field);
 * `{ field }` keys variants on a payload field (used for wire events such as
 * `event_type` or `operation`). An example whose discriminant value has no
 * declared variant is an error, so adding an example without a schema fails.
 */
export interface VariantSpec {
  readonly discriminant: "example-name" | { readonly field: string };
  readonly variants: Readonly<Record<string, ObjectSpec>>;
}

export type PayloadSpec = ObjectSpec | VariantSpec;

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
 * Documented Polymarket credential, auth-header, and builder-attribution
 * names, each with the official page that documents it and the access date.
 *
 * SECRET MATERIAL — never permitted in a fixture except as a sanitized
 * placeholder, and never loaded by this repository:
 * - `POLYMARKET_PRIVATE_KEY` (signer private key)
 *   https://docs.polymarket.com/trading/quickstart and
 *   https://docs.polymarket.com/getting-started/migrate-from-previous-sdks
 *   (both accessed 2026-08-26)
 * - `SIGNER_PRIVATE_KEY` (signer private key, raw-API examples)
 *   https://docs.polymarket.com/trading/place-orders (accessed 2026-08-26)
 * - `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`,
 *   `POLYMARKET_BUILDER_PASSPHRASE` (builder API key triple, passed to
 *   `builderApiKey({ key, secret, passphrase })`)
 *   https://docs.polymarket.com/getting-started/migrate-from-previous-sdks
 *   (accessed 2026-08-26)
 * - `POLY_API_KEY`, `POLY_PASSPHRASE`, `POLY_SIGNATURE` (CLOB L2 auth headers)
 *   https://docs.polymarket.com/trading/place-orders (accessed 2026-08-26)
 * - `POLY_BUILDER_API_KEY`, `POLY_BUILDER_PASSPHRASE`,
 *   `POLY_BUILDER_SIGNATURE`, `POLY_BUILDER_TIMESTAMP` (builder auth headers)
 *   https://docs.polymarket.com/api-reference/relayer/submit-a-transaction
 *   (accessed 2026-08-26)
 *
 * ACCOUNT-IDENTIFYING but not secret — still scanned, because a fixture must
 * not carry a real account identity:
 * - `POLYMARKET_WALLET_ADDRESS`
 *   https://docs.polymarket.com/trading/quickstart and the migration page
 *   (accessed 2026-08-26)
 * - `POLY_ADDRESS`, `POLY_TIMESTAMP` (L2 header components)
 *   https://docs.polymarket.com/trading/place-orders (accessed 2026-08-26)
 *
 * PUBLIC BUILDER ATTRIBUTION — not secret material; it is a public builder
 * profile identifier sent alongside an order as `builderCode`. It is scanned
 * anyway so that a fixture cannot embed a real builder's attribution value:
 * - `POLYMARKET_BUILDER_CODE`
 *   https://docs.polymarket.com/trading/place-orders (accessed 2026-08-26;
 *   the same page is currently also served at
 *   https://docs.polymarket.com/builders/api-keys, which does NOT document
 *   the `POLY_BUILDER_*` headers — see report §16).
 *
 * Exact matches below are compared after normalization (lowercase
 * alphanumerics only), so `POLY_API_KEY`, `Poly-Api-Key`, and `polyApiKey`
 * all normalize to `polyapikey`.
 */
const CREDENTIAL_KEYS_NORMALIZED: readonly string[] = [
  "signedorder",
  "signedpayload",
  "seed",
  "authorization",
  "pk",
  // Documented Polymarket CLOB L2 auth headers / env names.
  "polyaddress",
  "polytimestamp",
  "polynonce",
  "polybuildertimestamp",
  "polymarketwalletaddress",
  "walletaddress",
];

/**
 * Credential/secret-shaped key patterns matched as substrings of the
 * normalized key, so that documented and obvious variants are covered without
 * enumerating every spelling: `POLYMARKET_PRIVATE_KEY`, `SIGNER_PRIVATE_KEY`,
 * and any other `*_PRIVATE_KEY` all contain `privatekey`;
 * `POLY_BUILDER_API_KEY`, `POLYMARKET_BUILDER_API_KEY`, and `builderApiKey`
 * all contain `apikey`; `POLYMARKET_BUILDER_SECRET`, `POLYMARKET_API_SECRET`,
 * `clientSecret`, and `secretKey` all contain `secret`.
 */
const CREDENTIAL_KEY_PATTERNS: readonly string[] = [
  "apikey",
  "secret",
  "privatekey",
  "privkey",
  "passphrase",
  "signature",
  "buildercode",
  "mnemonic",
  "seedphrase",
  "owner",
];

export function normalizeCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isCredentialShapedKey(key: string): boolean {
  const normalized = normalizeCredentialKey(key);
  return (
    CREDENTIAL_KEYS_NORMALIZED.includes(normalized) ||
    CREDENTIAL_KEY_PATTERNS.some((pattern) => normalized.includes(pattern))
  );
}

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
    if (isCredentialShapedKey(key) && !isSanitizedPlaceholder(entry)) {
      errors.push(
        `${path}.${key}: credential/secret-shaped field must be a sanitized placeholder`,
      );
    }
    scanForCredentials(entry, `${path}.${key}`, errors);
  }
}

/**
 * Canonical decimal string per handoff SS7.3: optional leading minus (never
 * on zero), no leading zeros, no trailing fractional zeros, no trailing
 * decimal point, no scientific notation, no leading plus. Canonical zero is
 * exactly "0".
 */
const CANONICAL_DECIMAL_RE = /^-?(0|[1-9]\d*)(\.\d*[1-9])?$/;

export function isCanonicalDecimalString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value === "-0") {
    return false;
  }
  return CANONICAL_DECIMAL_RE.test(value);
}

/**
 * Canonical decimal constrained to the price/probability range [0, 1].
 *
 * The bound is decided lexically on the canonical string, never through
 * binary floating point: `Number()` underflows values such as
 * `"-0.000…001"` to `-0` and rounds `"1.000…001"` to `1`, which would admit
 * out-of-range prices. Because the input is already canonical (no leading
 * zeros, no leading `+`, no exponent, no trailing fractional zeros), the
 * range test reduces to inspecting the sign and the integer part.
 */
export function isCanonicalPriceString(value: unknown): value is string {
  if (!isCanonicalDecimalString(value)) {
    return false;
  }
  // Any canonical negative is strictly below 0 ("-0" is already rejected).
  if (value.startsWith("-")) {
    return false;
  }
  const separator = value.indexOf(".");
  const integerPart = separator === -1 ? value : value.slice(0, separator);
  const hasFraction = separator !== -1;
  if (integerPart === "0") {
    // "0" and "0.<canonical fraction>" are always within [0, 1).
    return true;
  }
  if (integerPart === "1") {
    // Exactly "1" is in range; any fraction on top of 1 is strictly above 1
    // (a canonical fraction always ends in a non-zero digit).
    return !hasFraction;
  }
  return false;
}

const DIGIT_STRING_RE = /^\d+$/;
const HEX_STRING_RE = /^0x[0-9a-fA-F]*$/;

function validateField(
  value: unknown,
  spec: FieldSpec,
  path: string,
  errors: string[],
): void {
  if (spec.type === "union") {
    const alternatives = spec.oneOf ?? [];
    const matched = alternatives.some((alternative) => {
      const attempt: string[] = [];
      validateField(value, alternative, path, attempt);
      return attempt.length === 0;
    });
    if (!matched) {
      errors.push(
        `${path}: value matches none of the accepted alternatives [${alternatives
          .map((alternative) => alternative.type)
          .join(", ")}]`,
      );
    }
    return;
  }
  switch (spec.type) {
    case "unknown":
      return;
    case "string":
      if (typeof value !== "string") {
        errors.push(`${path}: expected string, got ${typeof value}`);
        return;
      }
      break;
    case "decimal-string":
      if (!isCanonicalDecimalString(value)) {
        errors.push(`${path}: expected canonical decimal string`);
        return;
      }
      break;
    case "empty-or-decimal-string":
      if (value !== "" && !isCanonicalDecimalString(value)) {
        errors.push(
          `${path}: expected canonical decimal string or the empty string (SDK OptionalDecimalStringSchema)`,
        );
        return;
      }
      break;
    case "price-string":
      if (!isCanonicalPriceString(value)) {
        errors.push(
          `${path}: expected canonical decimal string within [0, 1]`,
        );
        return;
      }
      break;
    case "empty-or-price-string":
      if (value !== "" && !isCanonicalPriceString(value)) {
        errors.push(
          `${path}: expected canonical decimal string within [0, 1] or the empty string (SDK OptionalDecimalStringSchema)`,
        );
        return;
      }
      break;
    case "digit-string":
      if (typeof value !== "string" || !DIGIT_STRING_RE.test(value)) {
        errors.push(
          `${path}: expected a digit string matching /^\\d+$/ (SDK epoch schema)`,
        );
        return;
      }
      break;
    case "hex-string": {
      if (typeof value !== "string" || !HEX_STRING_RE.test(value)) {
        errors.push(`${path}: expected a 0x-prefixed hex string`);
        return;
      }
      if (
        spec.hexLengths !== undefined &&
        !spec.hexLengths.includes(value.length)
      ) {
        errors.push(
          `${path}: expected a 0x-prefixed hex string of length [${spec.hexLengths.join(", ")}], got ${value.length}`,
        );
        return;
      }
      break;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${path}: expected finite number, got ${typeof value}`);
        return;
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push(
          `${path}: expected integer, got ${typeof value === "number" ? String(value) : typeof value}`,
        );
        return;
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(`${path}: expected boolean, got ${typeof value}`);
        return;
      }
      break;
    case "object": {
      if (!isRecord(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      // `FieldSpec` structurally satisfies `ObjectSpec` (same optional
      // `fields`/`values`/`strict` members), so the nested object rules are
      // applied directly without rebuilding the spec.
      validateObjectSpec(value, spec, path, errors);
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return;
      }
      if (spec.items !== undefined) {
        const items = spec.items;
        value.forEach((entry, index) => {
          validateField(entry, items, `${path}[${index}]`, errors);
        });
      }
      return;
    }
  }
  if (spec.enum !== undefined && typeof value === "string") {
    if (!spec.enum.includes(value)) {
      errors.push(
        `${path}: value ${JSON.stringify(value)} not in enum [${spec.enum.join(", ")}]`,
      );
    }
  }
}

function validateObjectSpec(
  value: Record<string, unknown>,
  spec: ObjectSpec,
  path: string,
  errors: string[],
): void {
  const fields = spec.fields ?? {};
  for (const [key, fieldSpec] of Object.entries(fields)) {
    const fieldPath = `${path}.${key}`;
    const present = Object.hasOwn(value, key);
    const entry = present ? value[key] : undefined;
    if (present && entry === null) {
      // `optional` governs KEY ABSENCE only and never admits an explicit
      // `null` (round-5 review finding HIGH). Only an explicit `nullable`,
      // backed by an official published type, accepts null.
      if (fieldSpec.nullable !== true) {
        errors.push(
          `${fieldPath}: null is not an accepted value (the spec must declare nullable; optional governs key absence only)`,
        );
      }
      continue;
    }
    if (!present || entry === undefined) {
      if (fieldSpec.optional !== true) {
        errors.push(`${fieldPath}: missing required key`);
      }
      continue;
    }
    validateField(entry, fieldSpec, fieldPath, errors);
  }
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(fields, key)) {
      continue;
    }
    const entry = value[key];
    if (spec.values !== undefined) {
      const valueSpec = spec.values;
      const entryPath = `${path}.${key}`;
      // Every map entry is validated against the declared value spec,
      // including `null`/`undefined`. Skipping them (as an earlier revision
      // did) let a map declared as decimals, integers, dual-limit objects, or
      // EVM addresses silently accept `null`. A map value may be `null` only
      // where its spec explicitly says so.
      if (entry === null) {
        if (valueSpec.nullable !== true) {
          errors.push(
            `${entryPath}: null is not an accepted value (map value spec does not declare nullable)`,
          );
        }
        continue;
      }
      if (entry === undefined) {
        if (valueSpec.optional !== true) {
          errors.push(
            `${entryPath}: undefined is not an accepted value (map value spec does not declare optional)`,
          );
        }
        continue;
      }
      validateField(entry, valueSpec, entryPath, errors);
      continue;
    }
    if (spec.strict === true) {
      errors.push(
        `${path}.${key}: unexpected key (schema is frozen against its official source)`,
      );
    }
  }
}

function isVariantSpec(spec: PayloadSpec): spec is VariantSpec {
  return Object.hasOwn(spec, "variants");
}

function discriminantLabel(
  discriminant: VariantSpec["discriminant"],
): string {
  return discriminant === "example-name"
    ? "example name"
    : `payload field "${discriminant.field}"`;
}

/**
 * Validates one example payload against a (possibly discriminated) spec.
 * Exported for direct unit testing of individual variants.
 */
export function validatePayload(
  payload: Record<string, unknown>,
  spec: PayloadSpec,
  exampleName: string,
  path: string,
  errors: string[],
): void {
  if (!isVariantSpec(spec)) {
    validateObjectSpec(payload, spec, path, errors);
    return;
  }
  const key =
    spec.discriminant === "example-name"
      ? exampleName
      : payload[spec.discriminant.field];
  if (typeof key !== "string") {
    errors.push(
      `${path}: discriminant (${discriminantLabel(spec.discriminant)}) is missing or not a string`,
    );
    return;
  }
  if (!Object.hasOwn(spec.variants, key)) {
    errors.push(
      `${path}: no schema variant declared for ${discriminantLabel(spec.discriminant)} ${JSON.stringify(key)} (declared: ${Object.keys(spec.variants).join(", ")})`,
    );
    return;
  }
  validateObjectSpec(payload, spec.variants[key] as ObjectSpec, path, errors);
}

/**
 * Validates the common fixture envelope and each example payload against a
 * source-specific spec (recursively: types, enums, optionality, nullability,
 * canonical decimal/price form, map values, unions, strict key sets, and
 * discriminated variants).
 */
export function validateFixtureDocument(
  raw: unknown,
  expectedFixtureName: string,
  spec: PayloadSpec,
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
      const name = example["name"];
      if (typeof name !== "string" || name.length === 0) {
        errors.push(`examples[${index}].name must be a non-empty string`);
      }
      const payload = example["payload"];
      if (!isRecord(payload)) {
        errors.push(`examples[${index}].payload must be an object`);
        return;
      }
      validatePayload(
        payload,
        spec,
        typeof name === "string" ? name : "",
        `examples[${index}].payload`,
        errors,
      );
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
  spec: PayloadSpec,
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
  const { fixture, errors } = validateFixtureDocument(raw, expectedName, spec);
  return { relativePath, ok: errors.length === 0, errors, fixture };
}
