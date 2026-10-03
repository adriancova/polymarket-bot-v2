/**
 * `CONTROL-1b` r4: the run-time no-signer guard, pinned in the repository's
 * unit runner (`test/vitest.config.ts`, its `control-api` project), which runs
 * this tree and `apps/control-api/src/**`. The pins, and why each is written
 * the way the static scan cannot read, are in
 * `test/integration/control-api/support/no-signer-runtime-pins.ts`; the guard
 * itself is `support/no-signer-guard.ts` there.
 */

import { pinNoSignerGuard } from "../../integration/control-api/support/no-signer-runtime-pins.js";

pinNoSignerGuard("repository unit (control-api project)");
