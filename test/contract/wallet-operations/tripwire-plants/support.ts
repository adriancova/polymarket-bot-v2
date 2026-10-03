/**
 * Shared by the network tripwire's plants (WP-300c; see
 * `../network-tripwire.test.ts`).
 *
 * A plant calls `fetch` ON PURPOSE, to prove that the suite's tripwire
 * (`../network-tripwire.setup.ts`) catches the call. A plant must never reach
 * the network, even if the setup file stops being loaded. So every plant calls
 * `requireTripwire()` first, OUTSIDE the `try` it uses to swallow the
 * tripwire's error. Without the tripwire the plant fails with this refusal and
 * calls nothing. The self-test does not accept the refusal as the expected
 * failure, so a missing tripwire fails the self-test; it never passes it.
 */

/** The tripwire's mark (the registered symbol the setup file puts on its `fetch`). */
const NETWORK_TRIPWIRE = Symbol.for("polymarket-bot.contract.wallet-operations.network-tripwire");

/** What a plant asks for. A reserved name (RFC 6761 `.invalid`); the tripwire throws before any request. */
export const PLANTED_URL = "https://example.invalid/planted-by-the-network-tripwire-self-test";

/** The refusal's message: the self-test checks that no plant failed for this reason. */
export const PLANT_REFUSAL = "tripwire plant refused: fetch is not the network tripwire, so nothing was called";

/** Throws unless the global `fetch` is the setup file's tripwire. */
export function requireTripwire(): void {
  const current: unknown = globalThis.fetch;
  if (typeof current !== "function" || Reflect.get(current, NETWORK_TRIPWIRE) !== true) {
    throw new Error(PLANT_REFUSAL);
  }
}
