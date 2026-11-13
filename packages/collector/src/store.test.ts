import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginEntry } from "@dsh-crate/schema";

import { ensureFirstSeenSeq, mergeEntries, type Catalog } from "./store.ts";

/** 造一条只关心 id / firstSeenAt / firstSeenSeq 的最小条目。 */
function entry(id: string, firstSeenAt: string, firstSeenSeq?: number): PluginEntry {
  return {
    id,
    firstSeenAt,
    firstSeenSeq,
    score: { maintenance: 0, utility: 0, popularity: 0, convenience: 0, total: 0 },
    sources: ["mirror"],
  } as unknown as PluginEntry;
}

test("ensureFirstSeenSeq：老数据按 firstSeenAt、id 回填 1..N 并返回下一个序号", () => {
  const entries = [
    entry("b/repo", "2026-01-02T00:00:00.000Z"),
    entry("a/repo", "2026-01-01T00:00:00.000Z"),
    entry("c/repo", "2026-01-02T00:00:00.000Z"),
  ];
  assert.equal(ensureFirstSeenSeq(entries), 4);
  // 回填按时间+id 排：a→1、b→2、c→3，原数组顺序不变。
  assert.deepEqual(entries.map(item => item.firstSeenSeq), [2, 1, 3]);
});

test("ensureFirstSeenSeq：序号齐全时原样保留，只返回下一个可用值", () => {
  const entries = [entry("a/repo", "2026-01-01T00:00:00.000Z", 7), entry("b/repo", "2026-01-02T00:00:00.000Z", 9)];
  assert.equal(ensureFirstSeenSeq(entries), 10);
  assert.deepEqual(entries.map(item => item.firstSeenSeq), [7, 9]);
});

test("mergeEntries：新条目按抓取顺序拿到递增序号，老条目序号不变", () => {
  const prev: Catalog = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: [entry("old/a", "2026-01-01T00:00:00.000Z", 1)],
  };
  const result = mergeEntries(prev, [
    { ...entry("new/first", "2026-02-01T00:00:00.000Z") },
    { ...entry("new/second", "2026-02-01T00:00:00.000Z") },
    { ...entry("old/a", "2026-02-02T00:00:00.000Z") },
  ]);
  const seq = new Map(result.catalog.entries.map(item => [item.id, item.firstSeenSeq]));
  assert.equal(seq.get("old/a"), 1);
  assert.equal(seq.get("new/first"), 2);
  assert.equal(seq.get("new/second"), 3);
  assert.equal(result.added, 2);
  assert.equal(result.updated, 1);
});
