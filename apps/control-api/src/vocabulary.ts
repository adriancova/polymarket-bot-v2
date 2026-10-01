/**
 * The control API's REQUEST GRAMMAR — and the vocabulary it refuses by name.
 *
 * ## Acceptance 1, stated as a property of the grammar
 *
 * > "Control API cannot raise mode above process maximum."
 *
 * The strongest form of that is not a check: it is that **no request can
 * express it**. There is no route, no body field and no query parameter here
 * that names a run mode, a real-order flag, a live-micro cap or a signer. The
 * ceiling is not an API-writable value at all — it is read from the process's
 * environment at startup by `safety.ts` and exposed read-only.
 *
 * A grammar can only be unrepresentable if nothing *else* is representable
 * either, so every request body this API accepts is a CLOSED object: unknown
 * keys are refused (`z.strictObject`) and, because ADR-020 §2 rules that
 * `strictObject` is not a mitigation on its own, the door materializes the
 * value prototype-free before the schema ever sees it.
 *
 * ## …and the belt beside the braces
 *
 * {@link FORBIDDEN_CONTROL_KEYS} is the defence-in-depth half. A request whose
 * body carries one of these keys is refused under
 * `CONTROL_MODE_RAISE_REFUSED`, **by name**, and the attempt is AUDITED. That
 * is redundant with the closed grammar by construction — a closed object would
 * refuse the key as unrecognized anyway — and it is kept for three reasons:
 *
 * 1. the refusal SAYS WHY. "unrecognized_keys: runMode" and "this API cannot
 *    raise a run mode; the ceiling is not writable" are different messages to
 *    an operator, and the second is the one the packet requires ("refused by
 *    name");
 * 2. it produces a counter (`control_mode_raise_attempts_refused_total`) for
 *    every authenticated caller, and an audit record for a caller holding a
 *    mutation grant, so a client repeatedly trying is visible rather than
 *    merely unsuccessful (a READ-only caller is counted, not audited:
 *    `CONTROL-1`, closing `WP-240` r1 M-3 — `api.ts`, step 3);
 * 3. it runs BEFORE the schema, so it also covers a body shape no schema
 *    matched — a request to an unknown route, or a body that failed for some
 *    other reason, still gets classified as an attempt if it named one of
 *    these.
 *
 * ## Scopes and actions are §14.1's, pinned to the WP-040 database vocabulary
 *
 * Both lists are `satisfies`-pinned to `packages/storage-postgres`'s
 * `KILL_SWITCH_SCOPES` / `KILL_SWITCH_ACTIONS`, which mirror the
 * `internal.kill_switch_scope` / `internal.kill_switch_action` SQL enums.
 * A rename in the schema is a TYPE ERROR here rather than a runtime insert
 * failure on the day an operator engages a kill switch.
 */

/**
 * TYPE-ONLY. `verbatimModuleSyntax` erases this import entirely, so the
 * `packages/storage-postgres` barrel — and therefore `pg` and `kysely` — is
 * **not** loaded by any module that merely needs the control vocabulary. The
 * runtime half of the pin lives in `vocabulary.database.test.ts`, which does
 * import the values and asserts set equality; only that file and the Postgres
 * audit sink pay the cost of loading a database client.
 */
import type {
  ActorKindValue,
  KillSwitchActionValue,
  KillSwitchScopeValue,
} from "@polymarket-bot/storage-postgres";

/**
 * §14.1's four kill-switch scopes.
 *
 * `satisfies` pins this to the database vocabulary in both directions: the
 * array must contain only values the enum admits, and the exported type is
 * asserted equal to `KillSwitchScopeValue` below.
 */
export const CONTROL_KILL_SWITCH_SCOPES = [
  "GLOBAL",
  "ACCOUNT",
  "MARKET",
  "STRATEGY_INSTANCE",
] as const satisfies readonly KillSwitchScopeValue[];

export type ControlKillSwitchScope = (typeof CONTROL_KILL_SWITCH_SCOPES)[number];

/** §14.1's five kill-switch actions. */
export const CONTROL_KILL_SWITCH_ACTIONS = [
  "HALT_NEW_ENTRIES",
  "CANCEL_ALL",
  "CANCEL_MARKET",
  "MANAGE_POSITIONS_ONLY",
  "FULL_HALT",
] as const satisfies readonly KillSwitchActionValue[];

export type ControlKillSwitchAction = (typeof CONTROL_KILL_SWITCH_ACTIONS)[number];

/**
 * The one §14.1 action this package ORDERS above the others (`CONTROL-1` r1,
 * closing `CONTROL1-J-M1`).
 *
 * §14.1 lists five actions and orders none of them. `FULL_HALT` is the only
 * one whose name claims to subsume the rest, so it is the only strengthening
 * this package recognizes: an engage over an engaged switch STRENGTHENS it
 * exactly when it changes the action to `FULL_HALT`. Every other pair of
 * distinct actions is treated as UNORDERED — neither provably stronger nor
 * provably weaker. `control-plane.ts` refuses an engage that would move a
 * switch away from `FULL_HALT` (that is a release, and a release needs
 * evidence); `audit-budget.ts` lets only a new switch or an escalation to
 * `FULL_HALT` use the kill-switch reserve.
 */
export const STRONGEST_KILL_SWITCH_ACTION = "FULL_HALT" as const satisfies ControlKillSwitchAction;

/**
 * A control-API caller is a human operator.
 *
 * §10.6's `actor_kind` also admits `AUTOMATED`, and this API does not offer it:
 * an automated actor would be a machine credential, and this deployment issues
 * operator credentials to people. Pinned to the database vocabulary so the
 * choice is visible as a choice rather than as an omission.
 */
export const CONTROL_ACTOR_KIND = "HUMAN" as const satisfies ActorKindValue;

/**
 * Keys whose PRESENCE in a request body is refused by name and audited.
 *
 * Matched case-insensitively against the key path of every node in the
 * materialized body, so `{ "config": { "runMode": "LIVE" } }` is caught as well
 * as a top-level `runMode`. The list covers, in order: the run-mode ceiling,
 * the real-order flag, both live-micro caps, and every signer/credential word
 * this repository uses.
 */
export const FORBIDDEN_CONTROL_KEYS: readonly string[] = Object.freeze([
  "runmode",
  "run_mode",
  "maxrunmode",
  "max_run_mode",
  "maximumrunmode",
  "maximum_run_mode",
  "mode",
  "allowrealorders",
  "allow_real_orders",
  "realorders",
  "real_orders",
  "livemicromaxordernotional",
  "live_micro_max_order_notional",
  "livemicromaxaccountexposure",
  "live_micro_max_account_exposure",
  "livemicro",
  "live_micro",
  "signer",
  "privatekey",
  "private_key",
  "apikey",
  "api_key",
  "passphrase",
  "secret",
  "mnemonic",
  "wallet",
  "credential",
]);

/**
 * True when a materialized request body names a forbidden key at any depth.
 *
 * Reads OWN keys only, from a tree the door has already materialized
 * prototype-free, and never reads a value — a body whose *value* happens to be
 * the string "LIVE" is not an attempt to raise anything, and refusing it would
 * make `reason: "halting because we are not going LIVE"` unwritable.
 */
export function forbiddenControlKeysIn(value: unknown): readonly string[] {
  const found = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 32 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      if (FORBIDDEN_CONTROL_KEYS.includes(key.toLowerCase())) found.add(key);
      walk((node as Record<string, unknown>)[key], depth + 1);
    }
  };
  walk(value, 0);
  return Object.freeze([...found].sort());
}
