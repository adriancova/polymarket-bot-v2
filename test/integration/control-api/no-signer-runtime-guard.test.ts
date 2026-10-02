/**
 * `CONTROL-1b` r2: the run-time no-signer guard, pinned in the control API's
 * integration runner (`vitest.config.ts`). The pins, and why each is written
 * the way the static scan cannot read, are in `support/no-signer-runtime-pins.ts`;
 * the guard itself is `support/no-signer-guard.ts`.
 */

import { pinNoSignerGuard } from "./support/no-signer-runtime-pins.js";

pinNoSignerGuard("control-api integration");
