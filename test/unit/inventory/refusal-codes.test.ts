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
 * WP300C-R2-X4 (INFO, round 2): the `x` bindings now include the two members
 * a re-entrant answer produces, wherever a trap can deliver a request without
 * moving the operation to another row (the three RECONCILING rows, answered
 * afterwards, and the quarantined row): a request received DURING the
 * answer's own read (a trap on `state` delivers it, and `requestId` names
 * it), and a plain answer naming a request that an EARLIER answer named
 * while it was being delivered during that answer's read (WP300C-R2-X1, the
 * verbatim replay). Each row asserts that both members were delivered.
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
import { ACCOUNT, CONDITION, NO, PUSD, RequestTokens, USDC_E, YES, requestIdOf, requestOrdinalOf, seededBook } from "./helpers.js";

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


type Executor = "pending" | "threw" | Readonly<Record<string, unknown>>;

/** What a binding adds to an answer: nothing (no request named) or a `requestId`. */
type Binding = Readonly<Record<string, unknown>>;
const NONE: Binding = {};
const named = (requestId: unknown): Binding => ({ requestId });

/**
 * WP300C-R2-X4: two `x` members that need a re-entrant answer, marked in a
 * binding's `requestId` and built by {@link deliverReentrant}: the request the
 * answer names was received DURING its own read; or the answer is a plain
 * replay naming a request an earlier answer named that way (WP300C-R2-X1).
 */
const DURING_READ = Symbol("received during the answer's own read");
const REPLAYED = Symbol("received during an earlier answer's read, then replayed");

interface Context {
  readonly manager: WalletOperationManager;
  readonly reconciler: Reconciler;
  /** A binding the answer is current under (evaluated at delivery: inside the call for a synchronous requester). */
  current: () => Binding | undefined;
  /** Bindings the answer is superseded under (none while PLANNED). */
  superseded: () => readonly Binding[];
  /** Bindings naming a request the reconciler had not received for "op" (see {@link DURING_READ}, {@link REPLAYED}). */
  unissued: () => readonly Binding[];
  /** WP300C-R2-X4: delivers a request for "op" without moving it to another row (a trap calls it during a read). */
  duringRead?: () => void;
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
  const tokens = new RequestTokens();
  const manager = new WalletOperationManager({ requestToken: tokens.next, book, approvals: new ApprovalTracker(), executor: port, reconciler });
  expect(manager.plan({ type: "WRAP_COLLATERAL", operationId: "op2", accountRef: ACCOUNT, amount: "10" }).ok).toBe(true);
  await manager.submit("op2");
  const r2 = reconciler.ids("op2").at(-1);
  if (r2 === undefined) throw new Error("op2 has no request");
  expect(manager.plan({ type: "SPLIT", operationId: "op", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }).ok).toBe(true);
  /** Every id issued for "op": received, or queued. */
  const issued = (): string[] => [
    ...reconciler.ids(),
    ...manager
      .outstandingReconciliationRequests()
      .filter((request) => request.walletOperationId === "op")
      .map((request) => request.requestId),
  ];
  /** The id of "op"'s `n`-th request (received or queued). */
  const id = (n: number): string => {
    const found = issued().find((requestId) => requestOrdinalOf(requestId) === n);
    if (found === undefined) throw new Error(`"op" has no request ${String(n)}`);
    return found;
  };
  const unissued = (extra: readonly string[] = [], reentrant = false): (() => readonly Binding[]) => () => [
    named(r2),
    named("wallet-op:foreign:reconciliation:1"),
    named("a-request-of-another-operation"),
    named(""),
    named(7),
    named({ requestId: "x" }),
    named(Symbol("request")),
    // "op"'s own next id, named before it exists: the exact id, token included (a reconciler that knows the source).
    named(requestIdOf("op", Math.max(0, ...issued().map((requestId) => requestOrdinalOf(requestId) ?? 0)) + 1, tokens.peek())),
    ...extra.map(named),
    ...(reentrant ? [named(DURING_READ), named(REPLAYED)] : []),
  ];
  return { manager, reconciler, release: (value: unknown) => release(value), unissued, id };
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
  expect(code(w.manager.resolveByReconciliation("op", ANSWER("AUTHORITATIVE_READ", "MINED", TX_A, null, named(w.id(1)))))).toBe("ok");
  expect(w.manager.operation("op")?.state).toBe("MINED");
  return w;
}

/** WP300C-R2-X4: an unrecognised report about A, observed from inside a trap: it delivers a request for "op". */
const dropped = (w: { readonly manager: WalletOperationManager }) => (): void =>
  void w.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });

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
      expect(code(w.manager.resolveByReconciliation("op", ANSWER("AUTHORITATIVE_READ", "MINED", TX_A, null, named(w.id(2)))))).toBe("ok");
      expect(w.manager.operation("op")?.state).toBe("MINED");
      return { ...w, current: () => named(w.id(2)), superseded: () => [named(w.id(1)), NONE], unissued: w.unissued() };
    }
    case "UNKNOWN, no request being delivered": {
      if (column === "N.c" || column === "T.c") {
        // First entry, nothing weighed: an answer naming no request is current.
        const w = await world("threw");
        w.reconciler.failing = true;
        await w.manager.submit("op");
        expect(w.manager.operation("op")?.state).toBe("UNKNOWN");
        return { ...w, current: () => NONE, superseded: () => [], unissued: w.unissued([w.id(1)]) };
      }
      // A re-entry with the reconciler down: request 2 queued (never received), request 1 superseded.
      const w = await backInFlight();
      w.reconciler.failing = true;
      w.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      expect(w.manager.operation("op")?.state).toBe("UNKNOWN");
      return { ...w, current: () => undefined, superseded: () => [named(w.id(1)), NONE], unissued: w.unissued([w.id(2)]) };
    }
    case "RECONCILING, simple mode": {
      // A re-entry that weighs nothing (a SUBMITTED after MINED): simple mode, request 2 current.
      const w = await backInFlight();
      const trigger = (): void => void w.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      if (!sync) trigger();
      // WP300C-R2-X4: answered afterwards, a trap's DROPPED(A) delivers a request (and ends simple mode: the `x`
      // codes are the same in the next row). Inside a request call nothing is delivered re-entrantly.
      return {
        ...w,
        current: () => named(w.id(2)),
        superseded: () => [named(w.id(1)), NONE],
        unissued: w.unissued([], !sync),
        ...(sync ? { trigger } : { duringRead: dropped(w) }),
      };
    }
    case "RECONCILING, every member by name": {
      // A re-entry that weighs an unrecognised observation: every member by name, request 2 current.
      const w = await backInFlight();
      const trigger = (): void => void w.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
      if (!sync) trigger();
      return {
        ...w,
        current: () => named(w.id(2)),
        superseded: () => [named(w.id(1)), NONE],
        unissued: w.unissued([], !sync),
        ...(sync ? { trigger } : { duringRead: dropped(w) }),
      };
    }
    case "RECONCILING, executor pending": {
      // Out of PLANNED while the executor call is pending: the observation that moved it was weighed.
      const w = await world("pending");
      void w.manager.submit("op");
      const trigger = (): void => void w.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
      if (!sync) trigger();
      return {
        ...w,
        current: () => named(w.id(1)),
        superseded: () => [NONE],
        unissued: w.unissued([], !sync),
        ...(sync ? { trigger } : { duringRead: dropped(w) }),
      };
    }
    case "CONFIRMED or FAILED, not quarantined":
    case "CONFIRMED or FAILED, quarantined": {
      const w = await backInFlight();
      w.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      expect(code(w.manager.resolveByReconciliation("op", ANSWER("AUTHORITATIVE_READ", "FAILED", TX_A, null, named(w.id(2)))))).toBe("ok");
      expect(w.manager.operation("op")?.state).toBe("FAILED");
      if (row === "CONFIRMED or FAILED, not quarantined") {
        return { ...w, current: () => named(w.id(2)), superseded: () => [named(w.id(1)), NONE], unissued: w.unissued() };
      }
      // A contradicting observation after the conclusion: quarantined, request 3 (A must be answered by name).
      w.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
      expect(w.manager.operation("op")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_A}`] });
      return {
        ...w,
        current: () => named(w.id(3)),
        superseded: () => [named(w.id(2)), named(w.id(1)), NONE],
        // WP300C-R2-X4: a trap's DROPPED(A) delivers a fresh quarantine request; the operation stays quarantined.
        unissued: w.unissued([], true),
        duringRead: dropped(w),
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

/** WP300C-R2-X4: how many re-entrant `x` members each row delivered, by member. */
const reentrantDelivered = new Map<string, number>();

/**
 * WP300C-R2-X4: deliver a re-entrant `x` member. A Proxy reporting an
 * answer's values calls `duringRead` on the first read of `state` (a request
 * is delivered), and its `requestId` names the request received last, as it
 * is when that field is read: the request delivered during the read. For
 * {@link DURING_READ} that Proxy is the variant's own answer; for
 * {@link REPLAYED} it is a carrier (an authoritative MINED(A), refused), and
 * the variant's answer then names the same id as plain data.
 */
function deliverReentrant(row: Row, context: Context, variant: Variant, which: typeof DURING_READ | typeof REPLAYED): string {
  const act = context.duringRead;
  if (act === undefined) throw new Error(`${row}: the state can deliver no request during a read`);
  const before = context.reconciler.ids();
  const values = (which === DURING_READ ? variant.make(named("placeholder")) : ANSWER("AUTHORITATIVE_READ", "MINED", TX_A, null)) as Readonly<
    Record<string, unknown>
  >;
  let fired = false;
  let namedId: string | undefined;
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(_target, key) {
        if (key === "state" && !fired) {
          fired = true;
          act();
        }
        if (key === "requestId") {
          namedId ??= context.reconciler.ids().at(-1);
          return { value: namedId, writable: true, enumerable: true, configurable: true };
        }
        if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(values, key)) return undefined;
        return { value: values[key], writable: true, enumerable: true, configurable: true };
      },
      has: () => false,
    },
  );
  const first = code(context.manager.resolveByReconciliation("op", proxy));
  // The id it named was delivered during its read: not received before, received by the time it was named.
  expect(fired, `${row}: the trap fired`).toBe(true);
  if (namedId === undefined) throw new Error(`${row}: requestId was never read`);
  expect(before, `${row}: the named request was received before the read`).not.toContain(namedId);
  expect(context.reconciler.ids(), `${row}: the named request was delivered during the read`).toContain(namedId);
  const key = `${row}|${String(which.description)}`;
  reentrantDelivered.set(key, (reentrantDelivered.get(key) ?? 0) + 1);
  if (which === DURING_READ) return first;
  expect(first, `${row}: the carrier is refused`).toBe(CODES["RQ"]);
  return code(context.manager.resolveByReconciliation("op", variant.make(named(namedId))));
}

/** Deliver one answer in a freshly built state; returns its code. */
async function deliver(row: Row, column: Column, variant: Variant, index: number, sync: boolean): Promise<string | null> {
  const context = await setUp(row, column, sync);
  if (!sync) {
    const binding = variant.binding(context)[index];
    if (binding === undefined) return null;
    const which = binding["requestId"];
    if (which === DURING_READ || which === REPLAYED) return deliverReentrant(row, context, variant, which);
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

  /** WP300C-R2-X4: the rows whose `x` bindings include the re-entrant members (answered afterwards). */
  const REENTRANT_ROWS: readonly Row[] = [
    "RECONCILING, simple mode",
    "RECONCILING, every member by name",
    "RECONCILING, executor pending",
    "CONFIRMED or FAILED, quarantined",
  ];

  for (const row of ROWS) {
    const forms = row.startsWith("RECONCILING") ? ([false, true] as const) : ([false] as const);
    for (const sync of forms) {
      it(`${row}${sync ? " (answered inside the request call)" : ""}: every column`, async () => {
        const cells = table.get(row);
        if (cells === undefined) throw new Error(`row "${row}" missing`);
        for (const which of [DURING_READ, REPLAYED]) reentrantDelivered.delete(`${row}|${String(which.description)}`);
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
        // WP300C-R2-X4: both re-entrant members were delivered where a read can receive a request (never otherwise).
        for (const which of [DURING_READ, REPLAYED]) {
          const delivered = reentrantDelivered.get(`${row}|${String(which.description)}`) ?? 0;
          if (!sync && REENTRANT_ROWS.includes(row)) expect(delivered, `${row}: ${String(which.description)}`).toBeGreaterThan(0);
          else expect(delivered, `${row}: ${String(which.description)}`).toBe(0);
        }
      });
    }
  }
});
