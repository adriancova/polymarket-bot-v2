/**
 * The FROZEN DOMAIN SCHEMAS this package parses with, each wrapped by the
 * parsing arena at module load.
 *
 * WHY REUSE AND NOT RE-DERIVE: the §7.7 intent grammar, the §7.1 timestamp
 * grammar and the §7.2 market-id grammar are `packages/domain`'s contracts. A
 * private copy would drift the day the frozen contract gains a field by ADR —
 * the exact failure `packages/risk` documents for shape copies. This package
 * therefore asks the domain's own schemas, through a declared DOWNWARD edge
 * (layer 1 → layer 0, `docs/contracts/dependency-direction.md` §2).
 *
 * WHY THE ARENA: every `zod` parse is exposed to the measured cross-package
 * classes (IMPLEMENTATION_STATUS.md, Open blockers — adoption, loss, defeated
 * defaults, `skipChecks`, inherited `when`, the poisoned cold first parse).
 * Each door is a prototype-free, warmed copy; its ANSWER is used and its
 * OUTPUT is discarded — every value this package acts on comes from its own
 * materialized tree (`plain-data.ts`), never from the library's assembly.
 *
 * NOTE ON `zod` ITSELF: this package declares NO `zod` dependency. It calls
 * `.safeParse` on schema OBJECTS the domain package exports, and the arena
 * copies them structurally; no `zod` module specifier appears anywhere here,
 * so the boundary cannot silently grow a second schema vocabulary.
 */

import {
  IntentSchema,
  InternalMarketIdSchema,
  IsoTimestampSchema,
} from "@polymarket-bot/domain";

import { prototypeFreeParser } from "./schema-arena.js";

/** §7.7 intents, discriminated on `type`. Built (and warmed) at module load. */
export const IntentDoor = prototypeFreeParser(IntentSchema);

/** ISO-8601 instant with explicit offset (§7.1 style). */
export const IsoTimestampDoor = prototypeFreeParser(IsoTimestampSchema);

/** `InternalMarketId` — canonical lowercase UUIDv7 (§7.2). */
export const InternalMarketIdDoor = prototypeFreeParser(InternalMarketIdSchema);
