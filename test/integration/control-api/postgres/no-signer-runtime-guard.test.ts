/**
 * `CONTROL-1b` r2: the run-time no-signer guard, pinned in the control API's
 * PostgreSQL runner (`postgres/vitest.config.ts`), which runs this tree. It
 * starts no container. The pins are `../support/no-signer-runtime-pins.ts`.
 */

import { pinNoSignerGuard } from "../support/no-signer-runtime-pins.js";

pinNoSignerGuard("control-api PostgreSQL");
