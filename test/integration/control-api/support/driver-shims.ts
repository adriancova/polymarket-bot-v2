/**
 * `CONTROL-2` r1 — the PostgreSQL driver in the shipped control API, stated
 * EXACTLY: the third-party packages it brings into the bundle, the Node
 * builtins it needs, the shim modules the `build` script aliases those
 * builtins to, and the stub it aliases `pg-native` to. The orchestrator's S2
 * grant (2026-10-04) admits the driver on these terms; an extra or a missing
 * entry fails `acceptance-3-shipped-artifact.test.ts`.
 *
 * ## Why the builtins go through shims
 *
 * `pg` and its dependencies are CommonJS and `require()` Node builtins
 * (`require("events")`, `require("net")`, …). The control API ships as an ES
 * module bundle, and esbuild leaves such a `require` of an external to a
 * run-time helper that throws "Dynamic require of "events" is not supported" —
 * the bundle dies at load (measured on the first r1 build). The ADR-018 cure
 * the trader uses, a `createRequire(import.meta.url)` banner, would put a real
 * module loader in the shipped artifact, which acceptance 3 forbids. Instead
 * the build aliases each builtin the driver requires to a one-line ES module
 * under `src/driver-shims/` that re-exports it (`export * from "node:dns"`):
 * the driver's `require("dns")` then resolves at BUILD time to that module,
 * and the bundle holds only STATIC imports of builtins — no `require`, no
 * `import()` and no dynamic-require helper at all (pinned on the output).
 *
 * Each shim is production source, so the production-source rule and the
 * test-tree scan read it; four of them import a builtin outside
 * `PERMITTED_BUILTINS` (`dns`, `string_decoder`, `tls`, `util/types`), which
 * each admits for exactly its own shim file, and the shipped-artifact check
 * pins every shim's text byte for byte.
 *
 * It imports nothing, so every reader can share it.
 */

/** The third-party packages the driver brings into the bundle, exactly (the grant's measured fifteen). */
export const DRIVER_THIRD_PARTY: readonly { readonly name: string; readonly justification: string }[] = Object.freeze([
  {
    name: "kysely",
    justification:
      "@polymarket-bot/storage-postgres's typed query builder (createDatabase): the trader-halt source's two selects run " +
      "through it; ES modules, tree-shaken, and the bundle holds no import() (pinned)",
  },
  { name: "pg", justification: "the PostgreSQL client the pool and the reader's sessions use (createPostgresPool), JavaScript only" },
  {
    name: "pg-cloudflare",
    justification: "pg's socket for the Cloudflare Workers runtime: under Node it resolves to an empty module and opens nothing",
  },
  { name: "pg-connection-string", justification: "pg's parser of the database URL into connection parameters; loads no module" },
  { name: "pg-int8", justification: "pg-types' exact 64-bit integer text parser; arithmetic only, loads no module" },
  { name: "pg-pool", justification: "pg's connection pool, which bounds the reader to its configured maximum of connections" },
  { name: "pg-protocol", justification: "pg's PostgreSQL wire-protocol serializer and parser; buffers in and out, loads no module" },
  { name: "pg-types", justification: "pg's text-to-value type parsers, which createPostgresPool overrides per pool; loads no module" },
  {
    name: "pgpass",
    justification: "pg's reader of the libpq password file, consulted only when the database URL carries no password",
  },
  { name: "postgres-array", justification: "pg-types' parser of PostgreSQL array literals; string parsing only, loads no module" },
  { name: "postgres-bytea", justification: "pg-types' parser of bytea text into a Buffer; string parsing only, loads no module" },
  { name: "postgres-date", justification: "pg-types' parser of date and timestamp text; string parsing only, loads no module" },
  { name: "postgres-interval", justification: "pg-types' parser of interval text; string parsing only, loads no module" },
  { name: "split2", justification: "pgpass's line splitter over the password file's stream; a Transform, loads no module" },
  { name: "xtend", justification: "postgres-interval's object-merge helper (one function); loads no module" },
]);

/**
 * The Node builtins the driver needs — each one a module that cannot load or
 * run code — EXACTLY. Each is imported by its own shim and by nothing else
 * the driver brings; the ones `PERMITTED_BUILTINS` does not list are admitted
 * for their shim only.
 */
export const DRIVER_BUILTINS: readonly { readonly builtin: string; readonly justification: string }[] = Object.freeze([
  { builtin: "crypto", justification: "pg's SCRAM-SHA-256 password authentication (pg/lib/crypto/utils.js): hashes and random bytes" },
  {
    builtin: "dns",
    justification: "pg's connection parameters (pg/lib/connection-parameters.js): name resolution for libpq's string; it resolves names and loads nothing",
  },
  { builtin: "events", justification: "pg's client, connection and query, and pg-pool: EventEmitter" },
  { builtin: "fs", justification: "pgpass reads the libpq password file; pg-connection-string reads an sslcert/sslkey file the URL names" },
  { builtin: "net", justification: "pg's TCP socket to the server (pg/lib/stream.js, connection.js)" },
  { builtin: "path", justification: "pgpass locates the libpq password file under the home directory" },
  { builtin: "stream", justification: "pgpass and split2: Stream and Transform over the password file" },
  {
    builtin: "string_decoder",
    justification: "split2 decodes the password file's bytes to text (StringDecoder); it decodes and loads nothing",
  },
  {
    builtin: "tls",
    justification: "pg's TLS socket when the database URL asks for SSL (pg/lib/stream.js); it encrypts a socket and loads nothing",
  },
  { builtin: "util", justification: "pg's client and pgpass: deprecate, format and inherits" },
  {
    builtin: "util/types",
    justification: "pg's parameter serialization (pg/lib/utils.js): isDate; type predicates only, loading nothing",
  },
]);

/** Where the shims live, relative to `apps/control-api`. */
export const DRIVER_SHIM_DIRECTORY = "src/driver-shims";

/**
 * The builtins `@types/node` declares with `export =`, for which TypeScript
 * refuses `export *` (TS2498) though Node's ES module of each exports every
 * member by name: their shims carry one `@ts-expect-error` line.
 */
export const EXPORT_EQUALS_BUILTINS: readonly string[] = Object.freeze(["events", "path", "stream"]);

/** The shim file of `builtin`, relative to `apps/control-api`: `<name>/index.ts`, or `util/types.ts` for a subpath. */
export function driverShimFile(builtin: string): string {
  return builtin.includes("/") ? `${DRIVER_SHIM_DIRECTORY}/${builtin}.ts` : `${DRIVER_SHIM_DIRECTORY}/${builtin}/index.ts`;
}

/** The exact text of `builtin`'s shim. */
export function driverShimText(builtin: string): string {
  const lines = [
    `// \`CONTROL-2\` r1: the bundle's \`${builtin}\` for the PostgreSQL driver (package.json \`build\`; README, acceptance 3).`,
    ...(EXPORT_EQUALS_BUILTINS.includes(builtin)
      ? [
          `// @ts-expect-error TS2498: @types/node declares \`node:${builtin}\` with \`export =\`; Node's ES module of it exports every member by name.`,
        ]
      : []),
    `export * from "node:${builtin}";`,
  ];
  return `${lines.join("\n")}\n`;
}

/** The stub the build aliases `pg-native` to, relative to `apps/control-api`. */
export const PG_NATIVE_STUB = `${DRIVER_SHIM_DIRECTORY}/pg-native.ts`;

/** The one sentence the stub throws with, as its first words. */
export const PG_NATIVE_REFUSAL = "pg-native is not shipped with the control API";

/**
 * The `--alias` tokens the `build` script carries, in order: one per
 * top-level builtin the driver requires (a subpath such as `util/types`
 * follows its package's alias into the shim directory), then `pg-native`.
 */
export function driverAliasTokens(): readonly string[] {
  const packages = DRIVER_BUILTINS.map((entry) => entry.builtin).filter((builtin) => !builtin.includes("/"));
  return [
    ...packages.map((builtin) => `--alias:${builtin}=./${DRIVER_SHIM_DIRECTORY}/${builtin}`),
    `--alias:pg-native=./${PG_NATIVE_STUB}`,
  ];
}
