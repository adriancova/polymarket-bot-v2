// `CONTROL-2` r1: the bundle's `events` for the PostgreSQL driver (package.json `build`; README, acceptance 3).
// @ts-expect-error TS2498: @types/node declares `node:events` with `export =`; Node's ES module of it exports every member by name.
export * from "node:events";
