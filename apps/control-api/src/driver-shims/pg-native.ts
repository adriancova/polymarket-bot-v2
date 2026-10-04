// `CONTROL-2` r1: the bundle's `pg-native` (package.json `build`): pg's optional native binding is never shipped, and loading it fails.
export {};
throw new Error(
  "pg-native is not shipped with the control API: its bundle aliases pg's optional native binding to this module, " +
    "which refuses to load. The control API reads ops.incidents through pg's JavaScript client only; unset " +
    "NODE_PG_FORCE_NATIVE (README, 'Open trader halts').",
);
