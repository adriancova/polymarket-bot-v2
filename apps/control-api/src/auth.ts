/**
 * Operator authentication and explicit authorization — handoff §15.
 *
 * > "Control API uses authentication and explicit authorization for live-mode,
 * > kill-switch, config, and wallet-operation actions."
 *
 * That is the whole of §15 on this subject. It names four action classes and
 * requires two things of them; it does not specify a credential mechanism, a
 * transport, an identity provider, or a session model. **The interpretation
 * below is `WP-240`'s, marked as an interpretation, and is deliberately the
 * smallest thing that satisfies the sentence for a PAPER deployment.**
 *
 * ## INTERPRETATION (§15 is under-specified for a paper deployment)
 *
 * 1. **Authentication is a bearer operator token**, presented as
 *    `Authorization: Bearer <token>`. Tokens are supplied to the process as
 *    configuration; each is bound to an operator id, which is what appears in
 *    the audit log. There is no login endpoint, no session, and no token
 *    issuance: this process mints nothing, so there is nothing here to steal
 *    that is not already in the deployment's own configuration.
 * 2. **A token is compared in constant time, over a SHA-256 digest.** Digesting
 *    first makes both operands 32 bytes, so `timingSafeEqual` never throws on a
 *    length mismatch and the comparison leaks neither the length nor a prefix.
 * 3. **A token is never logged, echoed, included in a refusal, or used as an
 *    identifier.** A refusal names the REASON class, not the credential —
 *    §15's "Logs redact API keys, passphrases, signatures…". `auth.test.ts`
 *    asserts this against a token value that must not appear anywhere.
 * 4. **Authorization is an explicit grant set per operator**, checked per route
 *    and never inferred from authentication. §15 says "explicit", so a token
 *    that authenticates grants nothing by itself.
 * 5. **Of §15's four action classes, this API implements two and makes the
 *    other two unrepresentable.** Kill-switch: implemented, grant
 *    `KILL_SWITCH`. Config (strategy run state): implemented, grant
 *    `STRATEGY_CONTROL`. **Live-mode: no route, no field, no grant** — §11's
 *    ceiling is not writable here at all. **Wallet operations: no route, no
 *    field, no grant** — §4.1 says this process "never has the signing key",
 *    and a wallet operation needs one. Refusing a request is weaker than being
 *    unable to express it, and where the stronger property was available it was
 *    taken.
 * 6. **Transport security is the deployment's**, not this process's. §15's "no
 *    public network exposure for … internal metrics endpoints" is enforced by
 *    binding loopback only (`config.ts`), which is what makes a bearer token
 *    over plain HTTP acceptable HERE and would not make it acceptable on a
 *    public interface. A deployment that wants to expose this API off-host owes
 *    it a TLS terminator and, at that point, a stronger credential mechanism
 *    than this one; that is recorded as a follow-up rather than pretended.
 *
 * ## Weak configuration is refused at startup, not tolerated
 *
 * An empty token, a token under 32 characters, a duplicate token, and a
 * configuration with no operators at all are each refused by `config.ts`.
 * A control API that starts with no operator would be a control API that can
 * never be used and would look healthy doing it.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The explicit grants §15 requires.
 *
 * Deliberately coarse — one per action class this API implements. A finer
 * model (per-market, per-instance) is a real thing to want and is a follow-up;
 * inventing it now would be a permission system nobody has asked for, and every
 * grant it added would be another thing to get wrong.
 */
export const OPERATOR_GRANTS = ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] as const;
export type OperatorGrant = (typeof OPERATOR_GRANTS)[number];

/** One operator, as configuration. The token is held only as a digest. */
export interface OperatorCredential {
  readonly operatorId: string;
  readonly grants: readonly OperatorGrant[];
}

export type AuthenticationFailureReason =
  /** No `Authorization` header, or not a `Bearer` one. */
  | "MISSING_CREDENTIAL"
  /** A well-formed bearer token that matches no configured operator. */
  | "UNKNOWN_CREDENTIAL"
  /** The header was present but malformed beyond recovery. */
  | "MALFORMED_CREDENTIAL";

export type AuthenticationResult =
  | { readonly ok: true; readonly operator: OperatorCredential }
  | { readonly ok: false; readonly reason: AuthenticationFailureReason };

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * The configured operators, holding token DIGESTS rather than tokens.
 *
 * The plaintext token is used once, in the constructor, to compute a digest and
 * is then unreferenced. Nothing on this object can print a token because
 * nothing on this object HAS one.
 */
export class OperatorRegistry {
  readonly #operators: readonly { readonly credential: OperatorCredential; readonly digest: Buffer }[];

  constructor(operators: readonly { readonly operatorId: string; readonly token: string; readonly grants: readonly OperatorGrant[] }[]) {
    this.#operators = operators.map((operator) => ({
      credential: Object.freeze({
        operatorId: operator.operatorId,
        grants: Object.freeze([...operator.grants]),
      }),
      digest: digest(operator.token),
    }));
  }

  get size(): number {
    return this.#operators.length;
  }

  /** Every configured operator id, sorted. Ids are not secret; tokens are. */
  operatorIds(): readonly string[] {
    return Object.freeze(this.#operators.map((entry) => entry.credential.operatorId).sort());
  }

  /**
   * Authenticates an `Authorization` header value.
   *
   * CONSTANT TIME over the configured set: every operator is compared, and the
   * loop does not short-circuit on the first match, so the time taken does not
   * reveal WHICH operator matched or how far down the list it sat.
   */
  authenticate(header: string | undefined): AuthenticationResult {
    if (header === undefined || header === "") {
      return { ok: false, reason: "MISSING_CREDENTIAL" };
    }
    const match = /^Bearer[ ]([\x21-\x7e]+)$/u.exec(header);
    if (match === null) {
      // A header that is present but not a bearer credential. Distinguished
      // from "absent" so an operator debugging a client can tell "you sent
      // nothing" from "you sent something I cannot read" — neither message
      // contains any part of what was sent.
      return { ok: false, reason: header.startsWith("Bearer") ? "MALFORMED_CREDENTIAL" : "MISSING_CREDENTIAL" };
    }
    const presented = digest(match[1] ?? "");
    let found: OperatorCredential | undefined;
    for (const entry of this.#operators) {
      // Both operands are 32-byte digests, so this never throws on length and
      // never leaks a prefix.
      if (timingSafeEqual(presented, entry.digest)) found = entry.credential;
    }
    return found === undefined
      ? { ok: false, reason: "UNKNOWN_CREDENTIAL" }
      : { ok: true, operator: found };
  }
}

/** True when this operator holds the grant. Explicit: never inferred. */
export function hasGrant(operator: OperatorCredential, grant: OperatorGrant): boolean {
  return operator.grants.includes(grant);
}
