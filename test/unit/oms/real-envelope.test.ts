/**
 * WP-270 r1 (OP-R1-06): the REAL `SignedOrderEnvelope` (WP-260,
 * `packages/polymarket-secure/src/signed-order.ts`) through the OMS's
 * encrypted persistence and restore, at run time.
 * `port-conformance.test.ts` proves the shapes at compile time only.
 *
 * Nothing here signs: each envelope is built from a synthetic payload through
 * `SignedOrderEnvelope.fromPersistedPayload` (the envelope's public restore
 * door), so no signer, key, SDK or network is involved. Only `signed-order.ts`
 * is loaded, and it imports `node:util` plus the SDK's TYPES (erased).
 *
 * The real envelope's payload has 14 required keys and an optional `postOnly`;
 * the suites' fake restorer mirrors that (r1), and both restorers are run
 * here on every shape.
 */

import { describe, expect, it } from "vitest";

import type { LimitOrderRequest, PlacementOutcome, SignedOrderHandle } from "../../../packages/oms/src/index.js";
import { SignedOrderEnvelope } from "../../../packages/polymarket-secure/src/signed-order.js";

import { MAKER, SIGNER, accepted, restoreFakeSignedOrder, signatureFor, venueError, venueIdFor } from "./support/fake-venue.js";
import { group, openHarness, reopen, ticket, type Harness } from "./support/harness.js";

type PostOnlyKey = "absent" | boolean;

const UNKNOWN_425: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("ENGINE_RESTARTING", "UNKNOWN", 1) };

/** Make the fake venue "sign" with REAL envelopes built from synthetic payloads; returns each salt's payload. */
function realEnvelopes(h: Harness, postOnlyKey: PostOnlyKey): Map<string, Readonly<Record<string, string | number | boolean>>> {
  const payloads = new Map<string, Readonly<Record<string, string | number | boolean>>>();
  h.venue.sign = (request: LimitOrderRequest, salt: string) => {
    const payload: Record<string, string | number | boolean> = {
      builder: `0x${"0".repeat(64)}`,
      expiration: request.expirationUnixSeconds ?? 0,
      maker: MAKER,
      makerAmount: "1000000",
      metadata: `0x${"0".repeat(64)}`,
      orderType: request.expirationUnixSeconds === undefined ? "GTC" : "GTD",
      salt,
      side: request.side,
      signature: signatureFor(salt),
      signatureType: 3,
      signer: SIGNER,
      takerAmount: "2000000",
      timestamp: "1790000000000",
      tokenId: request.assetId,
    };
    if (postOnlyKey !== "absent") payload["postOnly"] = postOnlyKey;
    const order = SignedOrderEnvelope.fromPersistedPayload(payload);
    if (order === undefined) throw new Error("the real envelope refused the synthetic payload");
    expect(SignedOrderEnvelope.isEnvelope(order)).toBe(true);
    h.venue.signed.push(salt);
    payloads.set(salt, Object.freeze({ ...payload }));
    return Object.freeze({ kind: "SIGNED" as const, order });
  };
  return payloads;
}

describe("the real SignedOrderEnvelope, at run time", () => {
  it("a real envelope without the optional postOnly key goes through the DEFAULT harness restorer: persisted encrypted, restored after a restart", async () => {
    const h = await openHarness();
    realEnvelopes(h, "absent");
    const g = group(1);
    await h.manager.registerGroup(g);
    const result = await h.manager.submit(ticket(g, { n: 1 }));
    expect(result.ok && result.value.orderState).toBe("LIVE");
    const salt = h.venue.signed[0] as string;
    expect(h.store.serialized()).not.toContain(signatureFor(salt));
    const r = await reopen(h);
    const [attempt] = r.manager.attempts();
    expect(attempt).toMatchObject({ salt, signedPayloadAvailable: true });
    expect(r.manager.alerts().filter((alert) => alert.kind === "PAYLOAD_UNREADABLE")).toEqual([]);
  });

  for (const postOnlyKey of ["absent", false, true] as const) {
    it(`with the REAL restorer injected (postOnly ${String(postOnlyKey)}): encrypted at rest, restored as a real envelope with the identical payload, and resent unchanged on the 425 path after a restart`, async () => {
      const h = await openHarness({ restoreSignedOrder: SignedOrderEnvelope.fromPersistedPayload });
      const payloads = realEnvelopes(h, postOnlyKey);
      h.venue.placement = () => UNKNOWN_425;
      const g = group(10, { postOnly: postOnlyKey === true });
      await h.manager.registerGroup(g);
      const first = await h.manager.submit(ticket(g, { n: 10 }));
      if (!first.ok) throw new Error(`submit failed: ${first.refusal.code}`);
      const attemptId = first.value.submissionAttemptId;
      const salt = h.venue.signed[0] as string;
      const written = h.store.serialized();
      expect(written).not.toContain(signatureFor(salt));
      expect(written).not.toContain('"signature"');
      // The persisted ciphertext decrypts to exactly the real envelope's payload.
      const persisted = [...h.store.snapshotSync().attempts.values()][0];
      const plaintext = await h.cipher.decrypt(persisted?.signedPayload ?? { keyId: "", ciphertext: "" });
      expect(JSON.parse(plaintext)).toEqual(payloads.get(salt));
      // A restart restores it through the real envelope's own shape check.
      const r = await reopen(h);
      expect(r.manager.attempt(attemptId)).toMatchObject({ state: "RECONCILING", signedPayloadAvailable: true });
      expect(r.manager.alerts().filter((alert) => alert.kind === "PAYLOAD_UNREADABLE")).toEqual([]);
      const request = h.reconciler.latestFor(attemptId);
      const absent = await r.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
      expect(absent.ok && absent.value.absentConfirmed).toBe(true);
      expect(r.manager.resume().ok).toBe(true);
      let resentHandle: SignedOrderHandle | undefined;
      h.venue.placement = (handle) => {
        resentHandle = handle;
        return accepted(venueIdFor(handle.identity.salt));
      };
      const resent = await r.manager.retransmitSameSignedOrder(attemptId);
      expect(resent.ok && resent.value.orderState).toBe("LIVE");
      expect(SignedOrderEnvelope.isEnvelope(resentHandle)).toBe(true);
      expect(resentHandle?.revealPayloadForEncryptedPersistence()).toEqual(payloads.get(salt));
      expect(h.venue.signed).toEqual([salt]);
      expect(h.venue.received).toEqual([salt, salt]);
    });
  }

  it("the fake restorer accepts and refuses what the real one does: the optional postOnly; an unknown key, a missing required key, a non-boolean postOnly", () => {
    const base: Record<string, string | number | boolean> = {
      builder: `0x${"0".repeat(64)}`,
      expiration: 0,
      maker: MAKER,
      makerAmount: "1000000",
      metadata: `0x${"0".repeat(64)}`,
      orderType: "GTC",
      salt: "7",
      side: "BUY",
      signature: signatureFor("7"),
      signatureType: 3,
      signer: SIGNER,
      takerAmount: "2000000",
      timestamp: "1790000000000",
      tokenId: "1",
    };
    const { salt: _salt, ...missing } = base;
    void _salt;
    for (const [label, payload, ok] of [
      ["14 keys", base, true],
      ["postOnly false", { ...base, postOnly: false }, true],
      ["postOnly true", { ...base, postOnly: true }, true],
      ["an unknown key", { ...base, extra: "x" }, false],
      ["a missing key", missing, false],
      ["a string postOnly", { ...base, postOnly: "true" }, false],
    ] as const) {
      expect(SignedOrderEnvelope.fromPersistedPayload(payload) !== undefined, `real: ${label}`).toBe(ok);
      expect(restoreFakeSignedOrder(payload) !== undefined, `fake: ${label}`).toBe(ok);
    }
  });
});
