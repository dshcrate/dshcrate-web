import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginEntry } from "@dsh-shelfry/schema";

import {
  assertOfficialIndex,
  buildOfficialIndex,
  npmTargetOf,
  writeOfficialIndex,
  type PublishTimeCache,
} from "./market-index.ts";

/** 构造一条最小可用条目：只填索引映射用到的字段，其余给安全默认值。 */
function entry(id: string, patch: Partial<PluginEntry> = {}): PluginEntry {
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
    version: "1.0.0",
    downloads: null,
    install: {
      method: "pnpm-profile",
      command: `dsh plugin --profile web add ${id.split("/")[1] ?? id}`,
      packageName: id.split("/")[1] ?? id,
      enginesDsh: null,
      needsConfig: false,
      risky: false,
    },
    score: { maintenance: 0.5, utility: 0.5, popularity: 0.5, convenience: 0.5, total: 0.5 },
    sources: ["mirror"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

const TIMES: PublishTimeCache = { pkg: { "1.0.0": 1700000000 } };

test("npmTargetOf：识别 npm 规格并拒绝非 npm 安装方式", () => {
  assert.deepEqual(npmTargetOf("pkg"), { pkg: "pkg", pinned: null });
  assert.deepEqual(npmTargetOf("@scope/pkg"), { pkg: "@scope/pkg", pinned: null });
  assert.deepEqual(npmTargetOf("pkg@1.2.3"), { pkg: "pkg", pinned: "1.2.3" });
  assert.deepEqual(npmTargetOf("@scope/pkg@v2.0.0"), { pkg: "@scope/pkg", pinned: "2.0.0" });
  assert.deepEqual(npmTargetOf("pkg@latest"), { pkg: "pkg", pinned: null });
  assert.equal(npmTargetOf("github:owner/repo"), null);
  assert.equal(npmTargetOf("git+https://example.com/x.git"), null);
  assert.equal(npmTargetOf("<PACKAGE-NAME>"), null);
  assert.equal(npmTargetOf("-g"), null);
  assert.equal(npmTargetOf(null), null);
});

test("buildOfficialIndex：合格条目按官方字段输出", () => {
  const { index, skipped } = buildOfficialIndex([entry("owner/pkg")], TIMES);
  assert.equal(index.format, 1);
  assert.equal(index.plugins.length, 1);
  const plugin = index.plugins[0];
  assert.equal(plugin?.name, "pkg");
  assert.equal(plugin?.title, "owner/pkg");
  assert.equal(plugin?.description, "上游简介");
  assert.equal(plugin?.homepage, "https://shelfry.app/#/p/owner/pkg");
  assert.deepEqual(plugin?.repository, { url: "https://github.com/owner/pkg" });
  assert.deepEqual(plugin?.metadata, { category: "plugin" });
  assert.deepEqual(plugin?.versions, [
    { version: "1.0.0", publishTimestamp: 1700000000, source: { type: "npm" } },
  ]);
  assert.deepEqual(skipped, { noNpm: 0, noVersion: 0, noTime: 0, duplicate: 0 });
});

test("buildOfficialIndex：GitHub 条目补 owner 头像", () => {
  const { index } = buildOfficialIndex([entry("Owner-Name/pkg")], TIMES);
  assert.equal(index.plugins[0]?.icon, "https://avatars.githubusercontent.com/Owner-Name?size=64");
});

test("buildOfficialIndex：非 GitHub 形态与非法 owner 不补头像", () => {
  const ids = ["pkg", "a/b/c", "bad_name/pkg", "bad.name/pkg", `${"a".repeat(40)}/pkg`, "-lead/pkg"];
  for (const id of ids) {
    const { index } = buildOfficialIndex([entry(id)], TIMES);
    assert.equal(index.plugins[0]?.icon, undefined, id);
  }
});

test("assertOfficialIndex：带 icon 的索引仍通过本地校验", () => {
  const { index } = buildOfficialIndex([entry("owner/pkg")], TIMES);
  assert.equal(index.plugins[0]?.icon, "https://avatars.githubusercontent.com/owner?size=64");
  assert.doesNotThrow(() => assertOfficialIndex(index));
});

test("buildOfficialIndex：中文简介转成 {en,zh}，超长描述截到 160 字", () => {
  const long = "a".repeat(150) + " " + "b".repeat(60);
  const { index } = buildOfficialIndex(
    [entry("owner/pkg", { description: long, descriptionZh: "中".repeat(200) })],
    TIMES,
  );
  const plugin = index.plugins[0];
  const description = plugin?.description;
  assert.ok(description !== null && typeof description === "object");
  assert.equal(description.zh?.endsWith("…"), true);
  assert.equal(description.zh?.replace("…", "").length, 160);
  assert.equal(description.en?.endsWith("…"), true);
  assert.equal(description.en?.replace("…", "").length, 150);
});

test("buildOfficialIndex：缺 npm 包、缺版本、缺时间分别跳过", () => {
  const missingNpm = buildOfficialIndex(
    [entry("owner/a", { install: { ...entry("owner/a").install, packageName: "github:owner/a" } })],
    TIMES,
  );
  assert.equal(missingNpm.skipped.noNpm, 1);

  const missingVersion = buildOfficialIndex([entry("owner/pkg", { version: null })], TIMES);
  assert.equal(missingVersion.skipped.noVersion, 1);

  const missingTime = buildOfficialIndex([entry("owner/pkg", { version: "2.0.0" })], TIMES);
  assert.equal(missingTime.skipped.noTime, 1);
  assert.equal(missingTime.index.plugins.length, 0);
});

test("buildOfficialIndex：同名 npm 包去重，保留分数高的条目", () => {
  const pack = (id: string, total: number): PluginEntry =>
    entry(id, {
      version: "1.0.0",
      install: { ...entry(id).install, packageName: "pkg" },
      score: { ...entry(id).score, total },
    });
  const low = pack("owner/low", 0.3);
  const high = pack("owner/high", 0.9);
  const { index, skipped } = buildOfficialIndex([low, high], TIMES);
  assert.equal(index.plugins.length, 1);
  assert.equal(index.plugins[0]?.title, "owner/high");
  assert.equal(skipped.duplicate, 1);
});

test("buildOfficialIndex：类型映射到已声明的分类", () => {
  const CATEGORY_TIMES: PublishTimeCache = {
    theme: { "1.0.0": 1700000000 },
    skill: { "1.0.0": 1700000000 },
    tool: { "1.0.0": 1700000000 },
  };
  const { index } = buildOfficialIndex(
    [
      entry("owner/theme", { type: "theme" }),
      entry("owner/skill", { type: "skill" }),
      entry("owner/tool", { type: "unknown" }),
    ],
    CATEGORY_TIMES,
  );
  assert.deepEqual(
    index.plugins.map((plugin) => plugin.metadata.category).sort(),
    ["skill", "theme", "tool"],
  );
  for (const plugin of index.plugins) {
    assert.ok(index.metadata.categories[plugin.metadata.category] !== undefined);
  }
});

test("assertOfficialIndex：拒绝未声明的分类与空列表", () => {
  const { index } = buildOfficialIndex([entry("owner/pkg")], TIMES);
  index.plugins[0]!.metadata.category = "nope";
  assert.throws(() => assertOfficialIndex(index), /分类未在 metadata\.categories 声明/);
  assert.throws(() => assertOfficialIndex({ ...index, plugins: [] }), /plugins 不能为空/);
});

test("writeOfficialIndex：写入临时目录的 index.json，且不落缓存文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shelfry-index-"));
  try {
    const result = await writeOfficialIndex([entry("owner/pkg")], dir, TIMES);
    assert.equal(result.total, 1);
    assert.equal(result.queried, 0);
    assert.equal(existsSync(join(dir, "npm-publish-times.json")), false);
    const body = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { format: number; plugins: unknown[] };
    assert.equal(body.format, 1);
    assert.equal(body.plugins.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeOfficialIndex：一条都不合格时报错，不写空文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shelfry-index-"));
  try {
    await assert.rejects(() => writeOfficialIndex([entry("owner/pkg", { version: null })], dir, TIMES), /plugins 不能为空/);
    assert.equal(existsSync(join(dir, "index.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
