/**
 * WP-300c: the pin for WP300B-R1-03 (LOW), found by the WP-300b round-1
 * verifiers.
 *
 * The documentation said a terminal answer bound to a request not issued for
 * the operation, delivered in flight or while PLANNED, is refused
 * `WALLET_OP_EVIDENCE_SUPERSEDED`. A terminal state the observation classifier
 * does not recognise (CONFIRMED with no hash, a malformed identity, a negative
 * credited amount) is an unrecognised answer instead, refused
 * `WALLET_OP_ILLEGAL_TRANSITION`. The money behaviour was right; the stated
 * code was not.
 *
 * The header of `wallet-operation-manager.ts` now carries a table, REFUSAL
 * CODES, with the exact code for every state (row) and answer shape (column).
 * This suite READS THAT TABLE FROM THE SOURCE and checks every cell against
 * the code: it builds each state, delivers every variant of each shape, and
 * requires the codes returned to be exactly the codes documented (each one
 * reached, none other). The three "RECONCILING" rows are checked twice: once
 * with the answer delivered afterwards, and once by a synchronous requester
 * answering inside the request call (an UNKNOWN operation answering the
 * request being delivered). A row or column the suite does not know, or one
 * it knows that the table lacks, fails.
 *
 * All executors and reconcilers are in-memory mocks. Nothing is signed or sent.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ApprovalTracker,
  WalletOperationManager,
  type ReconciliationRequest,
  type WalletOperationExecutor,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, NO, PUSD, USDC_E, YES, seededBook } from "./helpers.js";

const MANAGER = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/inventory/src/wallet-operation-manager.ts");

const TX_A = "0x" + "a".repeat(64);
const TX_B = "0x" + "b".repeat(64);
const ID_R = "sanitized-relayer-id-r";

const CODES: Readonly<Record<string, string>> = {
  IT: "WALLET_OP_ILLEGAL_TRANSITION",
  SU: "WALLET_OP_EVIDENCE_SUPERSEDED",
  RQ: "WALLET_OP_EVIDENCE_REQUIRED",
  CF: "WALLET_OP_EVIDENCE_CONFLICT",
  ok: "ok",
};

const ROWS = [
  "PLANNED, not submitted",
  "PLANNED, executor pending",
  "SUBMITTED or MINED",
  "UNKNOWN, no request being delivered",
  "RECONCILING, simple mode",
  "RECONCILING, every member by name",
  "RECONCILING, executor pending",
  "CONFIRMED or FAILED, not quarantined",
  "CONFIRMED or FAILED, quarantined",
] as const;
type Row = (typeof ROWS)[number];

const COLUMNS = ["U", "N.c", "N.s", "N.x", "T.c", "T.s", "T.x", "H"] as const;
type Column = (typeof COLUMNS)[number];
type Shape = Exclude<Column, "H">;

/** A documented cell: the codes it may return, "shape" (the code of the answer's shape column), or unreachable. */
type Cell = { readonly kind: "codes"; readonly codes: readonly string[] } | { readonly kind: "shape" } | { readonly kind: "unreachable" };

/** The REFUSAL CODES table, read from the manager's header. */
function documentedTable(): ReadonlyMap<Row, ReadonlyMap<Column, Cell>> {
  const source = readFileSync(MANAGER, "utf8");
  const start = source.indexOf(" * REFUSAL CODES (WP300B-R1-03).");
  const end = source.indexOf(" * EVIDENCE AT THE DOOR", start);
  if (start < 0 || end < 0) throw new Error("the REFUSAL CODES table is missing from the manager's header");
  const lines = source
    .slice(start, end)
    .split("\n")
    .filter((line) => /^ \*\s+\|.*\|\s*$/.test(line))
    .map((line) =>
      line
        .replace(/^ \*\s+\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  const [header, ...body] = lines;
  if (header === undefined) throw new Error("the REFUSAL CODES table has no header");
  expect(header.slice(1)).toEqual([...COLUMNS]);
  expect(body.map((cells) => cells[0])).toEqual([...ROWS]);
  const table = new Map<Row, Map<Column, Cell>>();
  for (const cells of body) {
    const row = cells[0] as Row;
    const byColumn = new Map<Column, Cell>();
    for (const [index, column] of COLUMNS.entries()) {
      const text = cells[index + 1] ?? "";
      if (text === "—") byColumn.set(column, { kind: "unreachable" });
      else if (text === "shape") byColumn.set(column, { kind: "shape" });
      else {
        const codes = text.split("/").map((abbreviation) => {
          const full = CODES[abbreviation];
          if (full === undefined) throw new Error(`unknown code "${abbreviation}" in row "${row}", column ${column}`);
          return full;
        });
        byColumn.set(column, { kind: "codes", codes });
      }
    }
    table.set(row, byColumn);
  }
  return table;
}

// ---------------------------------------------------------- the states --

const code = (result: { ok: boolean; refusal?: { code: string } }): string => (result.ok ? "ok" : (result.refusal?.code ?? "?"));

class Reconciler {
  readonly received: ReconciliationRequest[] = [];
  failing = false;
  onRequest: ((request: ReconciliationRequest) => void) | undefined;
  request(request: ReconciliationRequest): void {
    if (this.failing) throw new Error("reconciler unavailable");
    this.received.push(request);
    this.onRequest?.(request);
  }
  ids(operationId = "op"): string[] {
    return this.received.filter((request) => request.walletOperationId === operationId).map((request) => request.requestId);
  }
}

/** The request id the manager gives operation "op"'s `n`-th request. */
const opId = (n: number): string => `9:wallet-op;2:op;14:reconciliation;${String(String(n).length)}:${String(n)};`;

type Executor = "pending" | "threw" | Readonly<Record<string, unknown>>;

/** What a binding adds to an answer: nothing (no request named) or a `requestId`. */
type Binding = Readonly<Record<string, unknown>>;
const NONE: Binding = {};
const named = (requestId: unknown): Binding => ({ requestId });

interface Context {
  readonly manager: WalletOperationManager;
  readonly reconciler: Reconciler;
  /** A binding the answer is current under (evaluated at delivery: inside the call for a synchronous requester). */
  current: () => Binding | undefined;
  /** Bindings the answer is superseded under (none while PLANNED). */
  superseded: () => readonly Binding[];
  /** Bindings naming a request the reconciler never received for "op". */
  unissued: () => readonly Binding[];
  /** For a synchronous form: the step whose request delivery the answer arrives inside. */
  trigger?: () => Promise<void> | void;
}

async function world(executor: Executor) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const reconciler = new Reconciler();
  let release: (value: unknown) => void = () => undefined;
  const port: WalletOperationExecutor = {
    submit: (submission) =>
      submission.operationId === "op2"
        ? Promise.resolve({ status: "???" })
        : executor === "pending"
          ? new Promise<unknown>((resolve) => {
              release = resolve;
            })
          : executor === "threw"
            ? Promise.reject(new Error("socket closed"))
            : Promise.resolve(executor),
  };
  const manager = new WalletOperationManager({ book, approvals: new ApprovalTracker(), executor: port, reconciler });
  expect(manager.plan({ type: "WRAP_COLLATERAL", operationId: "op2", accountRef: ACCOUNT, amount: "10" }).ok).toBe(true);
  await manager.submit("op2");
  const r2 = reconciler.ids("op2").at(-1);
  if (r2 === undefined) throw new Error("op2 has no request");
  expect(manager.plan({ type: "SPLIT", operationId: "op", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }).ok).toBe(true);
  const issued = (): number => reconciler.ids().length + manager.outstandingReconciliationRequests().filter((r) => r.walletOperationId === "op").length;
  const unissued = (extra: readonly string[] = []): (() => readonly Binding[]) => () => [
    named(r2),
    named("wallet-op:foreign:reconciliation:1"),
    named("a-request-of-another-operation"),
    named(""),
    named(7),
    named({ requestId: "x" }),
    named(Symbol("request")),
    // "op"'s own next id, named before it exists.
    named(opId(issued() + 1)),
    ...extra.map(named),
  ];
  return { manager, reconciler, release: (value: unknown) => release(value), unissued };
}

const ANSWER = (source: string, state: string, hash: string | null, id: string | null = null, extra: Binding = {}) => ({
  source,
  state,
  transactionHash: hash,
  transactionId: id,
  ...extra,
});
const auth = (state: string, hash: string | null, id: string | null = null) => (binding: Binding) =>
  ANSWER("AUTHORITATIVE_READ", state, hash, id, binding);

/**
 * The common prefix of the reconciliation rows: the executor answers NOT_SENT
 * naming A (unrecognised, nothing weighed: simple mode, request 1); a "still in
 * flight" answer for request 1 returns "op" to flight (MINED).
 */
async function backInFlight() {
  const w = await world({ status: "NOT_SENT", transactionHash: TX_A });
  await w.manager.submit("op");
  expect(w.manager.operation("op")?.state).toBe("RECONCILING");
  expect(code(w.manager.resolveByReconciliation("op", ANSWER("AUTHORITATIVE_READ", "MINED", TX_A, null, named(opId(1)))))).toBe("ok");
  expect(w.manager.operation("op")?.state).toBe("MINED");
  return w;
}

/** Build the state of `row` for `column`; `sync`: the answer will arrive inside the request call of the returned trigger. */
async function setUp(row: Row, column: Column, sync: boolean): Promise<Context> {
  switch (row) {
    case "PLANNED, not submitted": {
      const w = await world("pending");
      return { ...w, current: () => NONE, superseded: () => [], unissued: w.unissued() };
    }
    case "PLANNED, executor pending": {
      const w = await world("pending");
      void w.manager.submit("op");
      return { ...w, current: () => NONE, superseded: () => [], unissued: w.unissued() };
    }
    case "SUBMITTED or MINED": {
      // Back in flight after a re-entry: request 1 (and "none") superseded, request 2 current.
      const w = await backInFlight();
      w.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      expect(w.manager.operation("op")?.state).toBe("RECONCILING");
      expect(code(w.manager.resolveByReconciliation("op", ANSWER("AUTHORITATIVE_READ", "MINED", TX_A, null, named(opId(2)))))).toBe("ok");
      expect(w.manager.operation("op")?.state).toBe("MINED");
      return { ...w, current: () => named(opId(2)), superseded: () => [named(opId(1)), NONE], unissued: w.unissued() };
    }
    case "UNKNOWN, no request being delivered": {
      if (column === "N.c" || column === "T.c") {
        // First entry, nothing weighed: an answer naming no request is current.
        const w = await world("threw");
        w.reconciler.failing = true;
        await w.manager.submit("op");
        expect(w.manager.operation("op")?.state).toBe("UNKNOWN");
        return { ...w, current: () => NONE, superseded: () => [], unissued: w.unissued([opId(1)]) };
      }
      // A re-entry with the reconciler down: request 2 queued (never received), request 1 superseded.
      const w = await backInFlight();
      w.reconciler.failing = true;
      w.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      expect(w.manager.operation("op")?.state).toBe("UNKNOWN");
      return { ...w, current: () => undefined, superseded: () => [named(opId(1)), NONE], unissued: w.unissued([opId(2)]) };
    }
    case "RECONCILING, simple mode": {
      // A re-entry that weighs nothing (a SUBMITTED after MINED): simple mode, request 2 current.
      const w = await backInFlight();
      const trigger = (): void => void w.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      if (!sync) trigger();
      return { ...w, current: () => named(opId(2)), superseded: () => [named(opId(1)), NONE], unissued: w.unissued(), ...(sync ? { trigger } : {}) };
    }
    case "RECONCILING, every member by name": {
      // A re-entry that weighs an unrecognised observation: every member by name, request 2 current.
      const w = await backInFlight();
      const trigger = (): void => void w.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
      if (!sync) trigger();
      return { ...w, current: () => named(opId(2)), superseded: () => [named(opId(1)), NONE], unissued: w.unissued(), ...(sync ? { trigger } : {}) };
    }
    case "RECONCILING, executor pending": {
      // Out of PLANNED while the executor call is pending: the observation that moved it was weighed.
      const w = await world("pending");
      void w.manager.submit("op");
      const trigger = (): void => void w.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
      if (!sync) trigger();
      return { ...w, current: () => named(opId(1)), superseded: () => [NONE], unissued: w.unissued(), ...(sync ? { trigger } : {}) };
    }
    case "CONFIRMED or FAILED, not quarantined":
    case "CONFIRMED or FAILED, quarantined": {
      const w = await backInFlight();
      w.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      expect(code(w.manager.resolveByReconciliation("op", ANSWER("AUTHORITATIVE_READ", "FAILED", TX_A, null, named(opId(2)))))).toBe("ok");
      expect(w.manager.operation("op")?.state).toBe("FAILED");
      if (row === "CONFIRMED or FAILED, not quarantined") {
        return { ...w, current: () => named(opId(2)), superseded: () => [named(opId(1)), NONE], unissued: w.unissued() };
      }
      // A contradicting observation after the conclusion: quarantined, request 3 (A must be answered by name).
      w.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
      expect(w.manager.operation("op")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_A}`] });
      return {
        ...w,
        current: () => named(opId(3)),
        superseded: () => [named(opId(2)), named(opId(1)), NONE],
        unissued: w.unissued(),
      };
    }
  }
}

// --------------------------------------------------------- the shapes --

interface Variant {
  readonly label: string;
  /** For the H column: the shape whose column gives the code. */
  readonly shape: Shape;
  readonly make: (binding: Binding) => object;
  readonly binding: (context: Context) => readonly Binding[];
}

const current = (context: Context): readonly Binding[] => {
  const binding = context.current();
  return binding === undefined ? [] : [binding];
};
const superseded = (context: Context): readonly Binding[] => context.superseded();
const unissued = (context: Context): readonly Binding[] => context.unissued();
/** Any binding at all: unrecognised answers are refused before their binding matters. */
const anyBinding = (context: Context): readonly Binding[] => [...current(context), ...superseded(context).slice(0, 1), ...unissued(context).slice(0, 1)];

function withGetter(target: Record<string, unknown>, key: string, value: unknown): object {
  Object.defineProperty(target, key, { get: () => value, enumerable: true, configurable: true });
  return target;
}

const UNRECOGNISED: readonly { readonly label: string; readonly make: (binding: Binding) => object }[] = [
  { label: "an unknown state", make: (b) => auth("NOT_FOUND", TX_A)(b) },
  { label: "no state", make: (b) => ({ source: "AUTHORITATIVE_READ", transactionHash: TX_A, transactionId: null, ...b }) },
  { label: "NOT_SENT", make: (b) => auth("NOT_SENT", null)(b) },
  { label: "MINED with no hash", make: (b) => auth("MINED", null)(b) },
  { label: "CONFIRMED with no hash", make: (b) => auth("CONFIRMED", null)(b) },
  { label: "FAILED with a malformed hash", make: (b) => ({ ...auth("FAILED", null)(b), transactionHash: 5 }) },
  { label: "CONFIRMED with a negative credited amount", make: (b) => ({ ...auth("CONFIRMED", TX_A)(b), credited: "-1" }) },
  { label: "CONFIRMED with a numeric credited amount", make: (b) => ({ ...auth("CONFIRMED", TX_A)(b), credited: 10 }) },
  { label: "FAILED(A) whose requestId is a getter", make: (b) => withGetter(auth("FAILED", TX_A)(NONE), "requestId", b["requestId"] ?? "x") },
  {
    label: "FAILED(A) whose requestId is inherited",
    make: (b) => Object.assign(Object.create({ requestId: b["requestId"] ?? "x" }) as object, auth("FAILED", TX_A)(NONE)),
  },
  { label: "FAILED whose transactionHash is a getter", make: (b) => withGetter({ source: "AUTHORITATIVE_READ", state: "FAILED", transactionId: null, ...b }, "transactionHash", TX_A) },
  {
    label: "FAILED(A) whose transactionId is inherited",
    make: (b) => Object.assign(Object.create({ transactionId: ID_R }) as object, { source: "AUTHORITATIVE_READ", state: "FAILED", transactionHash: TX_A, ...b }),
  },
  { label: "CONFIRMED(A) whose credited amount is a getter", make: (b) => withGetter(auth("CONFIRMED", TX_A)(b), "credited", "1") },
  { label: "a getter state", make: (b) => withGetter({ source: "AUTHORITATIVE_READ", transactionHash: TX_A, transactionId: null, ...b }, "state", "FAILED") },
  { label: "FAILED(A) whose source is a getter", make: (b) => withGetter({ state: "FAILED", transactionHash: TX_A, transactionId: null, ...b }, "source", "AUTHORITATIVE_READ") },
  {
    label: "FAILED(A) whose transactionId read throws",
    make: (b) =>
      new Proxy(auth("FAILED", TX_A)(b), {
        getOwnPropertyDescriptor(target, key) {
          if (key === "transactionId") throw new Error("hostile trap");
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }),
  },
  {
    label: "a revoked Proxy",
    make: () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    },
  },
];

const VARIANTS: Readonly<Record<Column, readonly Variant[]>> = {
  U: UNRECOGNISED.map((u) => ({ ...u, shape: "U" as const, binding: anyBinding })),
  "N.c": [
    { label: "MINED(A)", shape: "N.c", make: auth("MINED", TX_A), binding: current },
    { label: "SUBMITTED(A)", shape: "N.c", make: auth("SUBMITTED", TX_A), binding: current },
    { label: "MINED(B), B never named", shape: "N.c", make: auth("MINED", TX_B), binding: current },
    { label: "SUBMITTED(null, R), naming no member", shape: "N.c", make: auth("SUBMITTED", null, ID_R), binding: current },
  ],
  "N.s": [{ label: "MINED(A)", shape: "N.s", make: auth("MINED", TX_A), binding: superseded }],
  "N.x": [{ label: "MINED(A)", shape: "N.x", make: auth("MINED", TX_A), binding: unissued }],
  "T.c": [
    { label: "FAILED(A)", shape: "T.c", make: auth("FAILED", TX_A), binding: current },
    { label: "CONFIRMED(A)", shape: "T.c", make: auth("CONFIRMED", TX_A), binding: current },
    { label: "FAILED(B), B never named", shape: "T.c", make: auth("FAILED", TX_B), binding: current },
    { label: "FAILED(null), naming nothing", shape: "T.c", make: auth("FAILED", null), binding: current },
  ],
  "T.s": [
    { label: "FAILED(A)", shape: "T.s", make: auth("FAILED", TX_A), binding: superseded },
    { label: "CONFIRMED(A)", shape: "T.s", make: auth("CONFIRMED", TX_A), binding: superseded },
  ],
  "T.x": [
    { label: "FAILED(A)", shape: "T.x", make: auth("FAILED", TX_A), binding: unissued },
    { label: "CONFIRMED(A)", shape: "T.x", make: auth("CONFIRMED", TX_A), binding: unissued },
    { label: "FAILED(null)", shape: "T.x", make: auth("FAILED", null), binding: unissued },
  ],
  H: [
    { label: "RELAYER_STATUS FAILED(A), current", shape: "T.c", make: (b) => ANSWER("RELAYER_STATUS", "FAILED", TX_A, null, b), binding: current },
    { label: "HEARSAY MINED(A), current", shape: "N.c", make: (b) => ANSWER("HEARSAY", "MINED", TX_A, null, b), binding: current },
    { label: "no source, CONFIRMED(A), current", shape: "T.c", make: (b) => ({ state: "CONFIRMED", transactionHash: TX_A, transactionId: null, ...b }), binding: current },
    { label: "RELAYER_STATUS FAILED(A), superseded", shape: "T.s", make: (b) => ANSWER("RELAYER_STATUS", "FAILED", TX_A, null, b), binding: superseded },
    { label: "HEARSAY MINED(A), superseded", shape: "N.s", make: (b) => ANSWER("HEARSAY", "MINED", TX_A, null, b), binding: superseded },
    { label: "RELAYER_STATUS FAILED(A), a request never received", shape: "T.x", make: (b) => ANSWER("RELAYER_STATUS", "FAILED", TX_A, null, b), binding: unissued },
    { label: "HEARSAY MINED(A), a request never received", shape: "N.x", make: (b) => ANSWER("HEARSAY", "MINED", TX_A, null, b), binding: unissued },
  ],
};

/** Deliver one answer in a freshly built state; returns its code. */
async function deliver(row: Row, column: Column, variant: Variant, index: number, sync: boolean): Promise<string | null> {
  const context = await setUp(row, column, sync);
  if (!sync) {
    const binding = variant.binding(context)[index];
    if (binding === undefined) return null;
    return code(context.manager.resolveByReconciliation("op", variant.make(binding)));
  }
  let result: string | null | undefined;
  context.reconciler.onRequest = (request) => {
    if (request.walletOperationId !== "op") return;
    context.reconciler.onRequest = undefined;
    // Inside the call: the request being delivered is the current one.
    const inside: Context = { ...context, current: () => named(request.requestId) };
    const binding = variant.binding(inside)[index];
    result = binding === undefined ? null : code(context.manager.resolveByReconciliation("op", variant.make(binding)));
  };
  await context.trigger?.();
  if (result === undefined) throw new Error(`${row}: the trigger delivered no request for "op"`);
  return result;
}

/** How many bindings a variant has in a state (built once, to enumerate them). */
async function bindingsCount(row: Row, column: Column, variant: Variant, sync: boolean): Promise<number> {
  const context = await setUp(row, column, false);
  const count = variant.binding(context).length;
  // A synchronous form has the same bindings: the current one is the request being delivered.
  return sync && variant.binding === current ? Math.max(count, 1) : count;
}

// ----------------------------------------------------------- the pin --

describe("WP300B-R1-03: the REFUSAL CODES table in the manager's header matches the code, cell by cell", () => {
  const table = documentedTable();

  it("the table has exactly the rows and columns this suite checks", () => {
    expect([...table.keys()]).toEqual([...ROWS]);
    for (const row of ROWS) expect([...(table.get(row)?.keys() ?? [])]).toEqual([...COLUMNS]);
  });

  for (const row of ROWS) {
    const forms = row.startsWith("RECONCILING") ? ([false, true] as const) : ([false] as const);
    for (const sync of forms) {
      it(`${row}${sync ? " (answered inside the request call)" : ""}: every column`, async () => {
        const cells = table.get(row);
        if (cells === undefined) throw new Error(`row "${row}" missing`);
        for (const column of COLUMNS) {
          const cell = cells.get(column);
          if (cell === undefined) throw new Error(`cell ${row} / ${column} missing`);
          const seen = new Set<string>();
          let delivered = 0;
          for (const variant of VARIANTS[column]) {
            const shapeCell = column === "H" && cell.kind === "shape" ? cells.get(variant.shape) : cell;
            if (shapeCell === undefined) throw new Error(`cell ${row} / ${variant.shape} missing`);
            const count = await bindingsCount(row, column, variant, sync);
            for (let index = 0; index < count; index += 1) {
              const result = await deliver(row, column, variant, index, sync);
              if (result === null) continue;
              const label = `${row}${sync ? " (sync)" : ""} / ${column}: ${variant.label} [binding ${String(index)}] → ${result}`;
              if (shapeCell.kind === "unreachable") throw new Error(`${label}: the table says this cannot happen`);
              if (shapeCell.kind === "shape") throw new Error(`${label}: "shape" is only for column H`);
              expect(shapeCell.codes, label).toContain(result);
              seen.add(result);
              delivered += 1;
            }
          }
          if (cell.kind === "unreachable") {
            expect(delivered, `${row} / ${column}: documented as unreachable`).toBe(0);
          } else {
            expect(delivered, `${row} / ${column}: no variant was delivered`).toBeGreaterThan(0);
            // Every documented code is reached (for "shape", checked in the shape columns themselves).
            if (cell.kind === "codes") expect([...seen].sort(), `${row} / ${column}: codes reached`).toEqual([...cell.codes].sort());
          }
        }
      });
    }
  }
});
