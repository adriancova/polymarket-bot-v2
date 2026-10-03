/**
 * The injected authenticated-socket port of the user stream (WP-280
 * deliverable 1). The subscription manager reaches the authenticated user
 * channel ONLY through this interface.
 *
 * WHAT THE PORT OWNS, AND WHY. The user channel authenticates with the CLOB
 * API credentials inside the subscription frame (`{"auth": {apiKey, secret,
 * passphrase}, "type": "user", "markets"?: [...]}`, `verified-2026-09-30.md`
 * §W.4). The port builds that frame, so the credential never passes through
 * the manager, its outputs, its errors or its logs: the manager hands the port
 * only condition ids. The port also owns the transport, and so the
 * classification of a lost connection (the venue documents no close codes for
 * this channel; a binding that maps them needs its own cited evidence).
 *
 * WHAT DOES NOT EXIST. No implementation of this port that opens a real
 * socket exists in this repository (PAPER only; `MAX_RUN_MODE=PAPER`). Every
 * test binds a mock fed from offline fixtures. Binding a real transport is a
 * later, human-gated item; and a factory given ANY port runs WP-260's run-mode
 * gate before it reads the port (`manager.ts`), so in PAPER no port method is
 * ever called.
 *
 * WHAT THE GATE DOES NOT COVER. The manager's gate guards the manager's USE of
 * a port. It cannot guard the CONSTRUCTION of a port: a binding that holds
 * credentials exists before the manager sees it. A live binding must
 * therefore run its own gate check before it reads any credential (inside
 * this package, behind WP-260's signer gate); no such binding exists today.
 *
 * Contract for an implementation:
 *
 * - `connect` starts ONE connection attempt and returns its handle at once;
 *   it reports through the handlers it was given, and only through them.
 * - `opened` is called once, when the transport is open; the manager then
 *   sends the subscription frame immediately ("Send the subscription frame
 *   immediately after connecting. The server may close a connection that
 *   remains unsubscribed.", S-D16).
 * - `frame` is called with each inbound TEXT frame, unparsed.
 * - `closed` is called at most once, with the port's classification of why
 *   the connection ended.
 * - After `close()`, the port calls no handler of that connection again (the
 *   manager ignores any that arrive anyway).
 * - Any method may throw; the manager treats a throw as a lost connection.
 * - A method that RETURNS is no evidence that its frame arrived, or that the
 *   connection was still alive when it was sent. Node v24.13.0's global
 *   `WebSocket.prototype.send` (undici) throws only while CONNECTING. It
 *   returns without an error when the socket is not established or is
 *   closing, and it only queues the data on an established one. So the
 *   manager keeps every market a connection subscribed to, or attempted to,
 *   in that connection's reconciliation scope for the rest of the
 *   connection's life, even after its unsubscribe frame was sent.
 */

/**
 * Why a connection ended, as the transport classifies it:
 *
 * - `CLOSED_BY_PEER`: the server closed the socket;
 * - `SERVER_ERROR`: the server reported an error and the connection ended;
 * - `AUTH_REJECTED`: the server refused the credentials;
 * - `TRANSPORT_ERROR`: the network or the socket failed.
 *
 * Any other value is treated as an unclassified loss.
 */
export type UserSocketCloseCause = "CLOSED_BY_PEER" | "SERVER_ERROR" | "AUTH_REJECTED" | "TRANSPORT_ERROR";

export const USER_SOCKET_CLOSE_CAUSES: readonly UserSocketCloseCause[] = Object.freeze([
  "CLOSED_BY_PEER",
  "SERVER_ERROR",
  "AUTH_REJECTED",
  "TRANSPORT_ERROR",
]);

/** The callbacks one connection reports through. */
export interface UserSocketHandlers {
  opened(): void;
  frame(text: string): void;
  closed(cause: UserSocketCloseCause): void;
}

/** One connection attempt. */
export interface UserSocketConnection {
  /**
   * Send the documented subscription frame for these condition ids. The port
   * adds `auth` and `type: "user"`; nothing else is sent.
   */
  subscribe(markets: readonly string[]): void;
  /** Send the documented `{"operation": "subscribe" | "unsubscribe", "markets": [...]}` frame (S-D15 lines 170–184). */
  updateSubscription(operation: "subscribe" | "unsubscribe", markets: readonly string[]): void;
  /** Send the text frame `PING`. */
  ping(): void;
  /** Close the connection. Idempotent. */
  close(): void;
}

export interface AuthenticatedUserSocketPort {
  connect(handlers: UserSocketHandlers): UserSocketConnection;
  /**
   * Optional: `true` only when `owner` (a maker order's `owner` field) is the
   * API-key identity this transport authenticates as. Only the port, which
   * holds the credential, can answer; the manager keeps only the verdict.
   * Without it, maker legs are `UNDETERMINED`: never projected as fills, and
   * every trade event that names one requests reconciliation
   * (`MAKER_LEG_OWNERSHIP_UNDETERMINED`), on either side of the trade.
   */
  isAccountOwner?(owner: string): boolean;
}
