/**
 * Internal market identity — handoff §9.2, §7.2.
 *
 * §9.2 requires the Universe Service to "Store both outcome tokens, condition
 * ID, event ID, tick size, minimum size, `negRisk`, fee schedule, trading delay,
 * open/close timestamps, and raw metadata". This module owns the identity half;
 * `parameters.ts` owns the versioned half.
 *
 * The identity is the binding between OUR identifier (`InternalMarketId`, a
 * UUIDv7 per §7.2) and the venue's (`conditionId`, the two `tokenId`s, the event
 * id and slug). It is immutable by construction: WP-040's
 * `markets_immutable_identity` trigger forbids changing `market_id` or
 * `condition_id` on an existing row, and the registry here refuses the same
 * thing rather than letting a re-registration quietly rewrite which venue market
 * an internal id refers to.
 *
 * `conditionId` stays an opaque venue string (`docs/contracts/domain.md` §8): its
 * internal structure is a volatile venue fact this repository does not encode.
 */

import {
  ConditionIdSchema,
  DetailStringSchema,
  InternalMarketIdSchema,
  NonEmptyStringSchema,
  TokenIdSchema,
} from "@polymarket-bot/domain";
import { z } from "zod";

export const MarketIdentitySchema = z
  .strictObject({
    /** Our identifier for this market (§7.2 UUIDv7). */
    internalMarketId: InternalMarketIdSchema,
    /** The venue's condition id (§7.2, opaque). */
    conditionId: ConditionIdSchema,
    /** The venue's event id: the container that groups related markets. */
    venueEventId: NonEmptyStringSchema.optional(),
    /** The venue slug, when the metadata carries one. */
    venueMarketSlug: NonEmptyStringSchema.optional(),
    yesTokenId: TokenIdSchema,
    noTokenId: TokenIdSchema,
    /** The market question, used by the series-suggestion heuristic. */
    questionTitle: DetailStringSchema.optional(),
  })
  .superRefine((identity, ctx) => {
    if (identity.yesTokenId === identity.noTokenId) {
      ctx.addIssue({
        code: "custom",
        path: ["noTokenId"],
        message: "the YES and NO outcome tokens must be different tokens",
      });
    }
  });

export type MarketIdentity = z.infer<typeof MarketIdentitySchema>;

/** Whether two identities describe the same venue market in the same way. */
export function isSameMarketIdentity(left: MarketIdentity, right: MarketIdentity): boolean {
  return (
    left.internalMarketId === right.internalMarketId &&
    left.conditionId === right.conditionId &&
    left.yesTokenId === right.yesTokenId &&
    left.noTokenId === right.noTokenId &&
    left.venueEventId === right.venueEventId &&
    left.venueMarketSlug === right.venueMarketSlug
  );
}
