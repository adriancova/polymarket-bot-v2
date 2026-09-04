/**
 * The `db/migrations` surface WP-210 owns, checked against the SQL rather than
 * claimed.
 *
 * Docker is NOT available in this environment (`docker compose config` fails
 * with "the command 'docker' could not be found in this WSL 2 distro"), so no
 * PostgreSQL instance was reached and none is claimed. Following the `WP-200`
 * precedent (`test/unit/ledger/wp040-persistence-shape.test.ts`), the DDL is
 * read as TEXT and parsed at runtime, so every assertion below is about the SQL
 * that will actually run.
 *
 * Two things are pinned:
 *
 * 1. **Migration 0009** resolves the recorded `catalog.settlement_specs.payoff_model`
 *    NOT NULL divergence, and resolves BOTH halves of ADR-009 §2 — nullable, and
 *    a model may not be named where none exists.
 * 2. **`data.raw_segments` and `data.dataset_manifests` already exist** in
 *    `WP-040`'s migration 0003. The operator decision that assigned them to
 *    WP-210 described them as an orphaned table needing creation; the premise is
 *    false, and WP-210 therefore ships a WRITER rather than a duplicate
 *    `create table` that would fail on the first migration run. This suite pins
 *    that finding so it cannot be quietly re-litigated.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIGRATIONS = join(REPO_ROOT, "db", "migrations");

/** The DDL with `--` comments removed FIRST (the `WP-200` lesson: prose contains SQL words). */
function sqlOf(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment < 0 ? line : line.slice(0, comment);
    })
    .join("\n");
}

function normalized(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

describe("migration 0009 — the payoff_model divergence, resolved per the records", () => {
  const up = normalized(sqlOf("0009_catalog_payoff_model_optional.up.sql"));
  const down = normalized(sqlOf("0009_catalog_payoff_model_optional.down.sql"));

  it("is a matched up/down pair, as the runner requires", () => {
    const files = readdirSync(MIGRATIONS).filter((file) => file.startsWith("0009_"));
    expect(files.sort()).toEqual([
      "0009_catalog_payoff_model_optional.down.sql",
      "0009_catalog_payoff_model_optional.up.sql",
    ]);
  });

  it("matches the runner's NNNN_name.(up|down).sql grammar", () => {
    for (const file of readdirSync(MIGRATIONS)) {
      expect(file, file).toMatch(/^\d{4}_[a-z0-9_]+\.(?:up|down)\.sql$/u);
    }
  });

  it("drops NOT NULL on catalog.settlement_specs.payoff_model", () => {
    expect(up).toContain(
      "alter table catalog.settlement_specs alter column payoff_model drop not null",
    );
  });

  it("adds ADR-009 §2's other half: no model may be named where none exists", () => {
    expect(up).toContain("settlement_specs_model_only_where_one_exists");
    expect(up).toContain(
      "payoff_model is null or observation_type in ('TERMINAL_SPOT', 'TWAP')",
    );
  });

  it("names the permitted observation types EXACTLY as the shipped compatibility matrix does", () => {
    // `packages/settlement/src/models/compatibility.ts` declares a TOTAL matrix
    // whose three empty rows are VWAP, EVENT_RESULT and MANUAL_ORACLE. The
    // constraint's permitted set must be the complement of those three, read
    // from the package rather than restated here.
    const compatibility = readFileSync(
      join(REPO_ROOT, "packages", "settlement", "src", "models", "compatibility.ts"),
      "utf8",
    );
    const permitted = new Set<string>();
    for (const observationType of [
      "TERMINAL_SPOT",
      "TWAP",
      "VWAP",
      "EVENT_RESULT",
      "MANUAL_ORACLE",
    ]) {
      // A model row names an observation type as a KEY of a requirements object.
      const declaresIt = new RegExp(`\\n {4}${observationType}: \\{`, "u").test(compatibility);
      if (declaresIt) permitted.add(observationType);
    }
    expect([...permitted].sort()).toEqual(["TERMINAL_SPOT", "TWAP"]);
    for (const observationType of permitted) {
      expect(up).toContain(`'${observationType}'`);
    }
    for (const withoutModel of ["VWAP", "EVENT_RESULT", "MANUAL_ORACLE"]) {
      expect(up).not.toContain(`'${withoutModel}'`);
    }
  });

  it("does NOT relax the immutability trigger: a change is a new spec_version", () => {
    // ADR-009 §1 / §6 invariant 9. Migration 0002's trigger already forbids
    // changing `payoff_model`; 0009 must not touch it, so a spec persisted with
    // no model can never gain one by UPDATE.
    expect(up).not.toContain("settlement_specs_immutable_semantics");
    expect(normalized(sqlOf("0002_catalog.up.sql"))).toContain("'payoff_model'");
  });

  it("rolls back by restoring the NOT NULL and dropping the new constraint", () => {
    expect(down).toContain("drop constraint settlement_specs_model_only_where_one_exists");
    expect(down).toContain(
      "alter table catalog.settlement_specs alter column payoff_model set not null",
    );
  });

  it("changes nothing else: it touches exactly one table", () => {
    const tablesTouched = [...up.matchAll(/alter table ([a-z_.]+)/gu)].map((match) => match[1]);
    expect(new Set(tablesTouched)).toEqual(new Set(["catalog.settlement_specs"]));
    expect(up).not.toContain("create table");
    expect(up).not.toContain("drop table");
  });
});

describe("the §10.2 replay catalog already exists (the operator decision's premise, measured)", () => {
  const data = normalized(sqlOf("0003_data.up.sql"));

  it("WP-040 migration 0003 already creates data.raw_segments", () => {
    expect(data).toContain("create table data.raw_segments (");
    expect(data).toContain("raw_segments_epoch_seq_unique unique (gateway_epoch, segment_seq)");
  });

  it("WP-040 migration 0003 already creates data.dataset_manifests and its children", () => {
    expect(data).toContain("create table data.dataset_manifests (");
    expect(data).toContain("create table data.dataset_manifest_segments (");
    expect(data).toContain("create table data.dataset_manifest_exclusions (");
  });

  it("so WP-210 ships no migration that creates either table", () => {
    for (const file of readdirSync(MIGRATIONS).filter((entry) => entry.startsWith("0009_"))) {
      const sql = normalized(sqlOf(file));
      expect(sql, file).not.toContain("create table data.raw_segments");
      expect(sql, file).not.toContain("create table data.dataset_manifests");
    }
  });

  it("records why the importer cannot fill four columns from a manifest alone", () => {
    // Each of these is NOT NULL in the DDL and is absent from a WP-130 dataset
    // manifest, which is why `createDatasetCatalogRepository` takes them as
    // required caller inputs instead of inventing them. Read from the SQL so the
    // claim cannot drift from the schema.
    const rawSegments = data.slice(
      data.indexOf("create table data.raw_segments ("),
      data.indexOf("create index raw_segments_epoch_idx"),
    );
    expect(rawSegments).toContain("source internal.event_source not null");
    expect(rawSegments).toContain("endpoint internal.detail not null");
    expect(rawSegments).toContain("segment_format internal.segment_format not null");
    // And the single digest column the ADR-017 §1 pair has to share.
    expect(rawSegments).toContain("content_sha256 internal.sha256_hex not null");
    expect(rawSegments).not.toContain("file_sha256");

    const manifests = data.slice(
      data.indexOf("create table data.dataset_manifests ("),
      data.indexOf("call internal.enforce_append_only('data', 'dataset_manifests')"),
    );
    expect(manifests).toContain("normalizer_version internal.identifier not null");
    expect(manifests).toContain("run_seed internal.uint_string not null");
    expect(manifests).toContain("manifest_hash internal.sha256_hex not null");
  });

  it("dataset_manifest_exclusions requires a CLOSED window, so an open incident is refused", () => {
    expect(data).toContain("dataset_manifest_exclusions_window check (window_end > window_start)");
  });
});
