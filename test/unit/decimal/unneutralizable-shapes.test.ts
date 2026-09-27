/**
 * THE NON-CONFIGURABLE SHAPES — one child process each (`WP-020-FU1` review
 * round 1, findings M1 and M3).
 *
 * WHAT ROUND 0 LEFT UNCOVERED. `packages/decimal/src/prototype-guard.ts` closes
 * the index-name class by neutralizing every array-index-named own property of
 * `Object.prototype` and `Array.prototype` for the duration of one operation.
 * Two branches of that mechanism had NO TEST AT ALL, and the round-1 reviewer
 * proved it with two mutations that survived all 869 tests:
 *
 * ```text
 * MH  delete the `shadowOnArrayPrototype` fallback
 *       -> 4 of the 5 non-configurable Object.prototype shapes fabricate again,
 *          including addDecimal("1","2") -> "990"
 * MF  delete the `arrayLength` undo
 *       -> the guard returns leaving Array.prototype.length PERMANENTLY at 1,
 *          which is the exact blocking class the module exists to prevent
 * ```
 *
 * AND WHAT ROUND 0 STATED FALSELY. The residual for `Array.prototype` was
 * documented as "fails closed: an untyped `TypeError`, never a fabricated
 * value", from three measured shapes. The other two fabricate — measured at base
 * `b4ce0aa` AND at round 0's tip `37fa983`, identically, so it was never a
 * regression, only an unmeasured claim:
 *
 * ```text
 * Array.prototype["0"] = non-configurable get/set pair
 *   addDecimal("100","-100")  "0" -> "9"      addDecimal("1","2")  "3" -> "990"
 * Array.prototype["0"] = non-configurable set-only accessor
 *   mulDecimal("2","3")       "6" -> "0"      compareDecimal("5","4")  1 -> 0
 * ```
 *
 * WHY CHILD PROCESSES. Every shape here is NON-CONFIGURABLE: it can never be
 * deleted or redefined, so installing one inside a vitest worker corrupts every
 * later file in that worker. Round 1 also measured that vitest's own machinery
 * breaks under these shapes — the reporter is a victim of the very class it is
 * reporting on. So the pollution lives in `prototype-shape-probe.ts`, one
 * process per shape, and this file asserts on the JSON it prints. Each spawn
 * carries an explicit timeout because the hang class is real (a get/set pair at
 * `Object.prototype["0"]` makes `decimal.js` loop; see the guard's header).
 *
 * THE BOUND ASSERTED HERE, per shape: every operation is EITHER byte-identical
 * to the same process's own clean measurement OR this package's typed
 * `HostilePrototypeError` refusal — never a third answer, and never a fabricated
 * value — AND the intrinsics are in exactly the state the probe found them in
 * (`Array.prototype.length` back where it was, descriptors deep-equal).
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

/**
 * Awaited, never synchronous (`CI-1`): a worker blocked on a child cannot read
 * vitest's own RPC replies (`test/unit/tooling/no-synchronous-spawn.test.ts`
 * says why that fails a run). Like the synchronous form, it rejects on a
 * non-zero exit, on the timeout and on an output overflow.
 */
const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(HERE, "prototype-shape-probe.ts");

/**
 * Per-spawn wall-clock ceiling.
 *
 * Generous relative to the measured cost (a probe run takes ~80 ms) because this
 * must fail with a diagnosis, not a hang: a shape that makes `decimal.js` loop
 * has to be reported as a timeout rather than block the suite forever.
 */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * File-level timeout, stated rather than defaulted (round-1 finding M2).
 *
 * Sixteen spawns at ~80 ms each is comfortably inside vitest's 5 s default, but
 * a gate that is one scheduler hiccup from red is not a gate. The number is a
 * ceiling on the whole file's slowest test, not a target.
 */
const FILE_TIMEOUT_MS = 60_000;

type Shape = "data-writable" | "data-readonly" | "get-only" | "set-only" | "get-set";

const SHAPES: readonly Shape[] = [
  "data-writable",
  "data-readonly",
  "get-only",
  "set-only",
  "get-set",
];

interface ProbeState {
  readonly arrayLength: number;
  readonly onArray: string;
  readonly onObject: string;
}

interface ProbeResult {
  readonly intrinsic: string;
  readonly name: string;
  readonly shape: string;
  readonly configurable: boolean;
  readonly clean: Readonly<Record<string, string>>;
  readonly polluted: Readonly<Record<string, string>>;
  readonly before: ProbeState;
  readonly after: ProbeState;
}

async function probe(
  intrinsic: "Array" | "Object",
  name: string,
  shape: Shape,
  configurable: boolean,
): Promise<ProbeResult> {
  // `execFile` takes no `stdio` option (its stdin is always a pipe); the probe
  // never reads stdin, so the former `"ignore"` changed nothing observable.
  const { stdout } = await execFileAsync(
    process.execPath,
    [PROBE, intrinsic, name, shape, String(configurable)],
    { encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
  );
  return JSON.parse(stdout) as ProbeResult;
}

/** The typed refusal, rendered by the probe as `THREW <class>(<code>): …`. */
const REFUSAL = "THREW HostilePrototypeError(DECIMAL_HOSTILE_PROTOTYPE):";

/** How each operation answered, classified. */
type Verdict = "byte-identical" | "refused" | "other";

function classify(result: ProbeResult): Readonly<Record<string, Verdict>> {
  const verdicts: Record<string, Verdict> = {};
  for (const operation of Object.keys(result.clean)) {
    const polluted = result.polluted[operation];
    if (polluted === result.clean[operation]) verdicts[operation] = "byte-identical";
    else if (polluted !== undefined && polluted.startsWith(REFUSAL)) verdicts[operation] = "refused";
    else verdicts[operation] = "other";
  }
  return verdicts;
}

function verdictSet(result: ProbeResult): readonly Verdict[] {
  return [...new Set(Object.values(classify(result)))].sort();
}

/**
 * Restoration is checked on EVERY row, not sampled.
 *
 * `arrayLength` is what mutation MF breaks and nothing else notices: the answers
 * stay correct while `Array.prototype` is left permanently at length 1.
 */
function expectIntrinsicsRestored(result: ProbeResult): void {
  expect(result.after.arrayLength, "Array.prototype.length was not restored").toBe(
    result.before.arrayLength,
  );
  expect(result.after.onArray, "the Array.prototype descriptor was not restored").toBe(
    result.before.onArray,
  );
  expect(result.after.onObject, "the Object.prototype descriptor was not restored").toBe(
    result.before.onObject,
  );
}

describe(
  "non-configurable index names on Object.prototype: the shadow fallback",
  { timeout: FILE_TIMEOUT_MS },
  () => {
    /**
     * All five shapes are byte-identical, and that is the mutation-killing
     * assertion: `shadowOnArrayPrototype` is the ONLY reason four of them are.
     * Deleting it (the reviewer's MH) turns `data-readonly`, `get-only`,
     * `set-only` and `get-set` into `refused` at this tip — and into
     * FABRICATION at round 0's tip, where there was no refusal to fall into.
     */
    it.each(SHAPES)('Object.prototype["0"] non-configurable %s answers as a clean process', async (shape) => {
      const result = await probe("Object", "0", shape, false);
      expect(verdictSet(result)).toStrictEqual(["byte-identical"]);
      expectIntrinsicsRestored(result);
      // The shadow is created on Array.prototype and must be gone afterwards,
      // with the length it raised put back (mutation MF).
      expect(result.after.arrayLength).toBe(0);
      expect(result.after.onArray).toBe("absent");
    });

    it("still answers as a clean process at a non-zero index", async () => {
      const result = await probe("Object", "3", "get-set", false);
      expect(verdictSet(result)).toStrictEqual(["byte-identical"]);
      expectIntrinsicsRestored(result);
      expect(result.after.arrayLength).toBe(0);
    });
  },
);

describe(
  "non-configurable index names on Array.prototype: the refusal (finding M1)",
  { timeout: FILE_TIMEOUT_MS },
  () => {
    /**
     * The one shape the engine lets the guard neutralize in place.
     * `ValidateAndApplyPropertyDescriptor` permits writing `[[Value]]` on a
     * non-configurable property that is still writable, so the guard does — and
     * at BASE this same shape made `addDecimal("100","-100")` answer `"9"`.
     */
    it('Array.prototype["0"] non-configurable data-writable is neutralized in place', async () => {
      const result = await probe("Array", "0", "data-writable", false);
      expect(verdictSet(result)).toStrictEqual(["byte-identical"]);
      expectIntrinsicsRestored(result);
      expect(result.after.onArray).toBe(
        "value=9 writable=true enumerable=false configurable=false",
      );
    });

    /**
     * The four the engine does not, which round 0 computed anyway. Two of them
     * FABRICATED; all four now refuse. `isZeroDecimal` and the tick check refuse
     * too — the refusal is a property of the guard, not of the operation.
     */
    it.each(["data-readonly", "get-only", "set-only", "get-set"] as const)(
      'Array.prototype["0"] non-configurable %s is refused, never computed',
      async (shape) => {
        const result = await probe("Array", "0", shape, false);
        expect(verdictSet(result)).toStrictEqual(["refused"]);
        expectIntrinsicsRestored(result);
        // The refusal names the intrinsic and the index, so an operator can find
        // the code that corrupted the realm.
        for (const answer of Object.values(result.polluted)) {
          expect(answer).toContain('Array.prototype["0"]');
        }
      },
    );

    it("refuses at a non-zero index too", async () => {
      const result = await probe("Array", "2", "get-only", false);
      expect(verdictSet(result)).toStrictEqual(["refused"]);
      for (const answer of Object.values(result.polluted)) {
        expect(answer).toContain('Array.prototype["2"]');
      }
      expectIntrinsicsRestored(result);
    });
  },
);

describe(
  "CONFIGURABLE index names on Array.prototype are neutralized, not refused",
  { timeout: FILE_TIMEOUT_MS },
  () => {
    /**
     * Non-vacuity for the refusal: it must fire on the shapes that cannot be
     * neutralized and NOWHERE ELSE. A guard that refused on every polluted
     * process would pass the block above and be useless.
     */
    it.each(SHAPES)('Array.prototype["0"] configurable %s answers as a clean process', async (shape) => {
      const result = await probe("Array", "0", shape, true);
      expect(verdictSet(result)).toStrictEqual(["byte-identical"]);
      expectIntrinsicsRestored(result);
    });
  },
);
