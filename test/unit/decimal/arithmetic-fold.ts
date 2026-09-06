/**
 * THE HONEST-PATH FOLD — a reproducible digest of what `packages/decimal`
 * answers, for a fixed corpus, in a clean process.
 *
 * WHY IT IS COMMITTED. `WP-020-FU1` round 0 claimed honest-path byte-identity
 * against base `b4ce0aa` on the strength of a fold digest, and the harness that
 * produced it was never committed — so the number could not be reproduced by the
 * reviewer, and an unreproducible digest is an assertion, not evidence
 * (round-1 review, evidence section). This file is that harness. Point it at any
 * checkout and it prints the same two digests for the same behaviour:
 *
 * ```sh
 * node test/unit/decimal/arithmetic-fold.ts                 # this tree
 * node test/unit/decimal/arithmetic-fold.ts /dev/shm/base   # any other tree
 * ```
 *
 * TWO DIGESTS, because two different things are worth pinning:
 *
 * - `valuesDigest` covers the ANSWERS only. A throw contributes the bare token
 *   `THREW`, with no class, code or message. This is the digest that must be
 *   identical across every commit that claims not to change arithmetic — it is
 *   deliberately blind to a refusal being RE-TYPED, which round 0 did on
 *   purpose.
 * - `fullDigest` additionally covers the class, the `code` and the message of
 *   every throw. It is the stricter statement and it is expected to MOVE when a
 *   round changes the error taxonomy.
 *
 * The corpus is fixed, small, and entirely canonical: every input is a string
 * this repository produces on ordinary paths. Nothing here is hostile input and
 * nothing here pollutes a prototype — this measures the HONEST path, which is
 * the one the guard must not have changed.
 *
 * Node runs this file directly (native type stripping); the resolve hook maps
 * the package's `./x.js` specifiers onto the `./x.ts` sources it ships. It is
 * not a `.test.ts` file, so vitest does not collect it;
 * `arithmetic-fold.test.ts` drives it.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      const parent = context.parentURL;
      if (parent !== undefined && parent.startsWith("file:")) {
        const candidate = new URL(`${specifier.slice(0, -3)}.ts`, parent);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

interface DivisionOptions {
  readonly precision?: number;
  readonly rounding?: number;
}

interface ArithmeticApi {
  readonly addDecimal: (a: string, b: string) => string;
  readonly subDecimal: (a: string, b: string) => string;
  readonly mulDecimal: (a: string, b: string) => string;
  readonly divDecimal: (a: string, b: string, options?: DivisionOptions) => string;
  readonly divDecimalExact: (a: string, b: string) => string;
  readonly compareDecimal: (a: string, b: string) => number;
  readonly equalsDecimal: (a: string, b: string) => boolean;
  readonly negateDecimal: (a: string) => string;
  readonly absDecimal: (a: string) => string;
  readonly isZeroDecimal: (a: string) => boolean;
  readonly isNegativeDecimal: (a: string) => boolean;
}

interface TickApi {
  readonly isTickConformant: (a: string, b: string) => boolean;
  readonly assertTickConformant: (a: string, b: string) => string;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_TREE = `${HERE}../../..`;
const tree = process.argv[2] ?? DEFAULT_TREE;

const arithmetic = (await import(`${tree}/packages/decimal/src/arithmetic.ts`)) as ArithmeticApi;
const tick = (await import(`${tree}/packages/decimal/src/tick.ts`)) as TickApi;

/**
 * The corpus. Canonical decimal strings only, chosen to reach every branch the
 * package documents: exact zero, the sign boundary, the unit interval a
 * Polymarket price lives in, sub-tick fractions, a repeating quotient, and
 * magnitudes far enough apart to exercise the digit-array growth that reads a
 * hole in the first place.
 */
const VALUES: readonly string[] = [
  "0",
  "1",
  "-1",
  "2",
  "3",
  "-3",
  "0.5",
  "-0.5",
  "0.01",
  "0.07",
  "0.37",
  "0.375",
  "0.9999",
  "-0.9999",
  "50",
  "-50",
  "100",
  "-100",
  "0.000001",
  "123456789",
  "-123456789",
  "123456789.123456789",
  "1000000000000",
  "0.333333333333333333333333333333333",
];

/** Tick sizes the venue actually uses, plus two that are off the usual grid. */
const TICKS: readonly string[] = ["0.0001", "0.001", "0.01", "0.1", "1", "0.5"];

/** Explicit division settings, so the explicit-options constructor is folded too. */
const DIVISIONS: ReadonlyArray<readonly [string, DivisionOptions | undefined]> = [
  ["default", undefined],
  ["p4", { precision: 4 }],
  ["p10r1", { precision: 10, rounding: 1 }],
];

const values = createHash("sha256");
const full = createHash("sha256");
let operations = 0;

/**
 * Folds one answer into both digests.
 *
 * The label is part of the preimage, so reordering or renaming a row changes the
 * digest — a fold whose rows could be permuted silently would not pin much.
 */
function fold(label: string, run: () => unknown): void {
  operations += 1;
  let valueLine: string;
  let fullLine: string;
  try {
    const answer = String(run());
    valueLine = `${label}\t${answer}`;
    fullLine = valueLine;
  } catch (error: unknown) {
    const thrown = error as { readonly constructor?: { readonly name?: string } };
    const named = error as { readonly code?: unknown; readonly message?: unknown };
    valueLine = `${label}\tTHREW`;
    fullLine = `${label}\tTHREW ${thrown.constructor?.name ?? "?"}(${String(named.code ?? "")}): ${String(named.message)}`;
  }
  values.update(`${valueLine}\n`, "utf8");
  full.update(`${fullLine}\n`, "utf8");
}

for (const a of VALUES) {
  fold(`negate ${a}`, () => arithmetic.negateDecimal(a));
  fold(`abs ${a}`, () => arithmetic.absDecimal(a));
  fold(`isZero ${a}`, () => arithmetic.isZeroDecimal(a));
  fold(`isNegative ${a}`, () => arithmetic.isNegativeDecimal(a));
  for (const t of TICKS) {
    fold(`tick ${a} % ${t}`, () => tick.isTickConformant(a, t));
    fold(`assertTick ${a} % ${t}`, () => tick.assertTickConformant(a, t));
  }
  for (const b of VALUES) {
    fold(`add ${a} + ${b}`, () => arithmetic.addDecimal(a, b));
    fold(`sub ${a} - ${b}`, () => arithmetic.subDecimal(a, b));
    fold(`mul ${a} * ${b}`, () => arithmetic.mulDecimal(a, b));
    fold(`cmp ${a} ? ${b}`, () => arithmetic.compareDecimal(a, b));
    fold(`eq ${a} = ${b}`, () => arithmetic.equalsDecimal(a, b));
    fold(`divExact ${a} / ${b}`, () => arithmetic.divDecimalExact(a, b));
    for (const [name, options] of DIVISIONS) {
      fold(`div[${name}] ${a} / ${b}`, () =>
        options === undefined
          ? arithmetic.divDecimal(a, b)
          : arithmetic.divDecimal(a, b, options),
      );
    }
  }
}

process.stdout.write(
  `${JSON.stringify({
    tree,
    corpus: VALUES.length,
    ticks: TICKS.length,
    operations,
    valuesDigest: values.digest("hex"),
    fullDigest: full.digest("hex"),
  })}\n`,
);
