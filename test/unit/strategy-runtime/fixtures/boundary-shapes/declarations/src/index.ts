/**
 * FIXTURE: a second entry point that is declarations only — the strategy SDK's
 * shape. Nothing here constructs a `DeclaredOnly`, so its member must NOT be
 * enumerated: an interface nobody here implements is somebody else's code.
 */

export type { DeclaredOnly } from "./declared.js";
