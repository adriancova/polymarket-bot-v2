/**
 * WP-270 r3 (WP270-R3-02, part b): the group write fits migration 0005.
 *
 * `execution.groups` has three NOT NULL columns the r2 `GroupRecord` lacked
 * (`group_ordinal`, `group_kind`, `limit_price`; 0005:105-109), so
 * `INSERT_GROUP` could not be a self-sufficient insert. The record now
 * carries every column of the row (and the two nullable ones), validated as
 * the schema's domains do, with `groups_ordinal_unique` and
 * `groups_ordinal_non_negative` enforced at registration; the in-memory store
 * enforces the NOT NULL columns and both constraints too.
 */

import { describe, expect, it } from "vitest";

import { OrderManager, type StoreWrite } from "../../../packages/oms/src/index.js";

import { uuid7 } from "./support/ids.js";
import { MemoryStore } from "./support/memory-store.js";
import { group, openHarness, reopen } from "./support/harness.js";

function groupWrites(log: readonly (readonly StoreWrite[])[]): readonly StoreWrite[] {
  return log.flat().filter((write) => write.kind === "INSERT_GROUP");
}

describe("WP270-R3-02: INSERT_GROUP carries every column of execution.groups", () => {
  it("writes the group ordinal, kind and limit price (NOT NULL in 0005), and the nullable release-after group and leg risk limit", async () => {
    const h = await openHarness();
    const first = group(1);
    const second = group(2, { groupKind: "LEG", limitPrice: "0.37", releaseAfterGroupId: first.executionGroupId, legRiskLimit: "12.5" });
    expect((await h.manager.registerGroup(first)).ok).toBe(true);
    expect((await h.manager.registerGroup(second)).ok).toBe(true);
    expect(groupWrites(h.store.log)).toEqual([
      {
        kind: "INSERT_GROUP",
        group: expect.objectContaining({ groupOrdinal: 1, groupKind: "SLICE", limitPrice: "0.5", releaseAfterGroupId: null, legRiskLimit: null }),
      },
      {
        kind: "INSERT_GROUP",
        group: expect.objectContaining({ groupOrdinal: 2, groupKind: "LEG", limitPrice: "0.37", releaseAfterGroupId: first.executionGroupId, legRiskLimit: "12.5" }),
      },
    ]);
    // The columns come back from the store on a restart: the same facts register idempotently, others are refused.
    const r = await reopen(h);
    expect((await r.manager.registerGroup(second)).ok).toBe(true);
    const changed = await r.manager.registerGroup({ ...second, limitPrice: "0.38" });
    expect(!changed.ok && changed.refusal.code).toBe("OMS_DUPLICATE_GROUP");
  });

  it("refuses a group without its execution.groups columns, or with values outside their domains", async () => {
    const h = await openHarness();
    const base = group(3);
    const { groupOrdinal: _o, groupKind: _k, limitPrice: _p, ...bare } = base;
    void [_o, _k, _p];
    const cases: readonly (readonly [string, unknown])[] = [
      ["no group ordinal", { ...bare, groupKind: "SLICE", limitPrice: "0.5" }],
      ["no group kind", { ...bare, groupOrdinal: 3, limitPrice: "0.5" }],
      ["no limit price", { ...bare, groupOrdinal: 3, groupKind: "SLICE" }],
      ["a negative ordinal", { ...base, groupOrdinal: -1 }],
      ["a fractional ordinal", { ...base, groupOrdinal: 1.5 }],
      ["an ordinal beyond a database integer", { ...base, groupOrdinal: 2_147_483_648 }],
      ["an ordinal as text", { ...base, groupOrdinal: "3" }],
      ["an unknown kind", { ...base, groupKind: "BASKET" }],
      ["a limit price above 1", { ...base, limitPrice: "1.2" }],
      ["a non-canonical limit price", { ...base, limitPrice: "0.50" }],
      ["a release-after group that is not a UUIDv7", { ...base, releaseAfterGroupId: "group-1" }],
      ["a group released after itself", { ...base, releaseAfterGroupId: base.executionGroupId }],
      ["a negative leg risk limit", { ...base, legRiskLimit: "-1" }],
    ];
    for (const [label, raw] of cases) {
      const result = await h.manager.registerGroup(raw);
      expect(!result.ok && result.refusal.code, label).toBe("OMS_INVALID_INPUT");
    }
    expect(groupWrites(h.store.log)).toEqual([]);
    // The domain's edges are accepted: [0, 1] for the price (internal.price_string), 0 for the ordinal.
    expect((await h.manager.registerGroup({ ...base, groupOrdinal: 0, limitPrice: "1" })).ok).toBe(true);
  });

  it("groups_ordinal_unique: a second group of the same plan cannot take an ordinal another group holds", async () => {
    const h = await openHarness();
    expect((await h.manager.registerGroup(group(4))).ok).toBe(true);
    const clash = await h.manager.registerGroup(group(5, { groupOrdinal: 4 }));
    expect(!clash.ok && clash.refusal.code).toBe("OMS_DUPLICATE_GROUP");
    expect(!clash.ok && clash.refusal.details).toMatchObject({ groupOrdinal: 4 });
    // Another plan may use the same ordinal.
    expect((await h.manager.registerGroup(group(6, { groupOrdinal: 4, planId: uuid7(0xb, 2) }))).ok).toBe(true);
    expect(groupWrites(h.store.log)).toHaveLength(2);
  });

  it("the in-memory store enforces the NOT NULL columns and both ordinal constraints (as 0005 does)", async () => {
    const store = new MemoryStore();
    const row = (n: number, edit: Record<string, unknown> = {}) =>
      ({ kind: "INSERT_GROUP", group: { ...group(n), releaseAfterGroupId: null, legRiskLimit: null, ...edit } }) as unknown as StoreWrite;
    await store.apply([row(7)]);
    await expect(store.apply([row(8, { groupOrdinal: undefined })])).rejects.toThrow("groups not null: groupOrdinal");
    await expect(store.apply([row(8, { groupKind: undefined })])).rejects.toThrow("groups not null: groupKind");
    await expect(store.apply([row(8, { limitPrice: undefined })])).rejects.toThrow("groups not null: limitPrice");
    await expect(store.apply([row(8, { groupOrdinal: -1 })])).rejects.toThrow("groups_ordinal_non_negative");
    await expect(store.apply([row(8, { groupOrdinal: 7 })])).rejects.toThrow("groups_ordinal_unique");
    await store.apply([row(8)]);
    expect(store.snapshotSync().groups.size).toBe(2);
  });

  it("a stored group row without its columns is refused at open (the snapshot is read as the schema's rows)", async () => {
    const h = await openHarness();
    await h.manager.registerGroup(group(9));
    const snapshot = await h.store.load();
    expect((await OrderManager.open({ ...h.deps, store: { apply: async () => undefined, load: async () => snapshot } })).ok).toBe(true);
    for (const column of ["groupOrdinal", "groupKind", "limitPrice"]) {
      const tampered = structuredClone(snapshot);
      delete (tampered.groups[0] as unknown as Record<string, unknown>)[column];
      const opened = await OrderManager.open({ ...h.deps, store: { apply: async () => undefined, load: async () => tampered } });
      expect(!opened.ok && opened.refusal.code, column).toBe("OMS_INVALID_INPUT");
    }
  });
});
