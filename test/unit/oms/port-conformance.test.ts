/**
 * WP-270: the OMS's ports mirror the real layer-1 and layer-2 surfaces they
 * stand for, checked at COMPILE TIME (`pnpm typecheck` builds this file):
 *
 * - `SecureVenueClient` (WP-260, `packages/polymarket-secure`) satisfies
 *   `OmsVenuePort`, and `SignedOrderEnvelope.fromPersistedPayload` satisfies
 *   `RestoreSignedOrder`; a real envelope is a `SignedOrderHandle`;
 * - `ReservationService` (WP-300, `packages/inventory`) satisfies
 *   `OmsReservationPort`.
 *
 * Type-only imports: nothing from the secure adapter is loaded at run time,
 * so no SDK, signer or network code runs here. `packages/oms` itself cannot
 * import either package (F12, F13); this test is how the mirror is held to
 * the real thing.
 */

import { describe, expect, it } from "vitest";

import type { ReservationService } from "../../../packages/inventory/src/index.js";
import type { OmsReservationPort, OmsVenuePort, RestoreSignedOrder, SignedOrderHandle } from "../../../packages/oms/src/index.js";
import type { SecureVenueClient, SignedOrderEnvelope } from "../../../packages/polymarket-secure/src/index.js";

type Assignable<To, From extends To> = From;

// Each alias fails to compile if the real surface stops satisfying the port.
export type VenueConforms = Assignable<OmsVenuePort, SecureVenueClient>;
export type EnvelopeConforms = Assignable<SignedOrderHandle, SignedOrderEnvelope>;
export type RestoreConforms = Assignable<RestoreSignedOrder, (typeof SignedOrderEnvelope)["fromPersistedPayload"]>;
export type ReservationsConform = Assignable<OmsReservationPort, ReservationService>;

describe("port conformance (compile-time)", () => {
  it("is checked by the typecheck gate", () => {
    const witness: readonly string[] = ["VenueConforms", "EnvelopeConforms", "RestoreConforms", "ReservationsConform"];
    expect(witness).toHaveLength(4);
  });
});
