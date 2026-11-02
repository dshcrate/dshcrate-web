import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MarketFile, PluginEntry } from "@dsh-shelfry/schema";

import { pickMarketAll, pickMarketTop, writeMarketAll, writeMarketTop } from "./emit.ts";

/** 构造一条最小可用条目：只填市场切片用到的字段，其余给安全默认值。 */
function entry(id: string, total: number, patch: Partial<PluginEntry> = {}): PluginEntry {
  return {
    id,
    name: id.split("/")[1] ?? id,
    fullName: id,
    ecosystem: "dsh",
    type: "cordis-plugin",
    stars: 10,
    description: "上游简介",
    descriptionZh: null,
    tags: [],
    curated: false,
    homepage: null,
    pushedAt: null,
    version: null,
    downloads: null,
    install: {
      method: "pnpm-profile",
      command: "dsh plugin --profile web add pkg",
      packageName: "pkg",
      enginesDsh: null,
      needsConfig: false,
      risky: false,
    },
    score: { maintenance: 0.5, utility: 0.5, popularity: 0.5, convenience: 0.5, total },
    sources: ["mirror"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

test("pickMarketTop：按综合分降序取前 N 条", () => {
  const entries = [entry("a/one", 40), entry("b/two", 90), entry("c/three", 65)];
  assert.deepEqual(pickMarketTop(entries, 2).map((e) => e.i), ["b/two", "c/three"]);
});

test("pickMarketTop：不原地排序入参数组", () => {
  const entries = [entry("a/one", 40), entry("b/two", 90)];
  pickMarketTop(entries, 2);
  // 后续产物（明细分片、反查表）都依赖原数组顺序，不能被这里打乱
  assert.deepEqual(entries.map((e) => e.id), ["a/one", "b/two"]);
});

test("pickMarketTop：分数相同时按星数、再按 id 稳定排序", () => {
  const entries = [entry("c/zip", 50, { stars: 10 }), entry("a/alpha", 50, { stars: 30 }), entry("b/beta", 50, { stars: 10 })];
  assert.deepEqual(pickMarketTop(entries, 3).map((e) => e.i), ["a/alpha", "b/beta", "c/zip"]);
});

test("pickMarketTop：只保留市场面板要用的字段", () => {
  const picked = pickMarketTop([entry("a/one", 80, { descriptionZh: "中文简介" })], 1)[0];
  assert.ok(picked);
  assert.deepEqual(Object.keys(picked).sort(), ["cmd", "d", "g", "i", "n", "s", "sc", "t", "vr"]);
  assert.equal(picked.d, "中文简介");
});

test("pickMarketTop：没有中文简介时回落到上游简介", () => {
  const picked = pickMarketTop([entry("a/one", 80)], 1)[0];
  assert.equal(picked?.d, "上游简介");
});

test("pickMarketTop：缺 id 的条目不进市场切片", () => {
  const picked = pickMarketTop([entry("", 99), entry("b/two", 20)], 5);
  assert.deepEqual(picked.map((e) => e.i), ["b/two"]);
});

test("pickMarketTop：空数组返回空切片", () => {
  assert.deepEqual(pickMarketTop([], 2000), []);
});

test("pickMarketTop：limit 大于总数时全量返回", () => {
  const entries = [entry("a/one", 30), entry("b/two", 10)];
  assert.equal(pickMarketTop(entries, 2000).length, 2);
});

test("pickMarketTop：非法 limit 直接抛错", () => {
  assert.throws(() => pickMarketTop([], 0), /limit 应为正整数/);
  assert.throws(() => pickMarketTop([], -1), /limit 应为正整数/);
  assert.throws(() => pickMarketTop([], 1.5), /limit 应为正整数/);
});

test("writeMarketTop：落盘文件包含元信息与裁剪后的条目", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-top-"));
  try {
    const entries = [entry("a/one", 40), entry("b/two", 90), entry("c/three", 65)];
    const out = writeMarketTop(entries, 2, dir);
    assert.equal(out.total, 2);
    const payload = JSON.parse(readFileSync(out.file, "utf8")) as MarketFile;
    assert.equal(payload.total, 2);
    assert.equal(typeof payload.schemaVersion, "number");
    assert.equal(typeof payload.generatedAt, "string");
    assert.deepEqual(payload.entries.map((e) => e.i), ["b/two", "c/three"]);
    assert.equal(payload.entries[0]?.cmd, "dsh plugin --profile web add pkg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickMarketAll：不截断全量，并按分数降序", () => {
  const entries = [entry("a/one", 40), entry("b/two", 90), entry("c/three", 65)];
  assert.deepEqual(pickMarketAll(entries).map((e) => e.i), ["b/two", "c/three", "a/one"]);
});

test("pickMarketAll：同 id 只保留一条，同名不同 id 都保留", () => {
  const entries = [entry("x/dup", 50), entry("x/dup", 90), entry("y/dup", 20)];
  const picked = pickMarketAll(entries);
  assert.deepEqual(picked.map((e) => e.i), ["x/dup", "y/dup"]);
  assert.equal(picked.length, 2);
  // 保留的是排序更靠前（分数更高）的那条
  assert.equal(picked[0]?.sc, 90);
});

test("pickMarketAll：缺 id 的条目跳过，空输入返回空切片", () => {
  assert.deepEqual(pickMarketAll([entry("", 99)]), []);
  assert.deepEqual(pickMarketAll([]), []);
});

test("writeMarketAll：落盘 dsh-shelfry.json，全量且含元信息", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-all-"));
  try {
    const entries = [entry("a/one", 40), entry("b/two", 90), entry("c/three", 65)];
    const out = writeMarketAll(entries, dir);
    assert.equal(out.total, 3);
    assert.equal(out.file, join(dir, "dsh-shelfry.json"));
    const payload = JSON.parse(readFileSync(out.file, "utf8")) as MarketFile;
    assert.equal(payload.total, 3);
    assert.equal(typeof payload.schemaVersion, "number");
    assert.equal(typeof payload.generatedAt, "string");
    assert.deepEqual(payload.entries.map((e) => e.i), ["b/two", "c/three", "a/one"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeMarketAll：空输入产出 total 为 0 的合法文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-all-empty-"));
  try {
    const out = writeMarketAll([], dir);
    const payload = JSON.parse(readFileSync(out.file, "utf8")) as MarketFile;
    assert.equal(payload.total, 0);
    assert.deepEqual(payload.entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
