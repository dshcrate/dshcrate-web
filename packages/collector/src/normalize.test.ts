import assert from "node:assert/strict";
import { test } from "node:test";

import { isThemeRepo, normalizeRecord } from "./normalize.ts";

/** 构造一条最小上游记录：只填类型判定用到的字段。 */
function raw(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "o/theme-one",
    name: "theme-one",
    fullName: "o/theme-one",
    type: "cordis-plugin",
    stars: 3,
    description: "上游简介",
    tags: [],
    install: {},
    ...patch,
  };
}

test("isThemeRepo：标签精确命中主题关键词", () => {
  assert.equal(isThemeRepo("o/a", "a", ["dsh-theme"]), true);
  assert.equal(isThemeRepo("o/a", "a", ["theme"]), true);
  assert.equal(isThemeRepo("o/a", "a", ["皮肤"]), true);
  assert.equal(isThemeRepo("o/a", "a", ["配色"]), true);
});

test("isThemeRepo：泛标签「主题」不触发，避免误收普通插件", () => {
  assert.equal(isThemeRepo("o/a", "a", ["主题", "效率提升"]), false);
});

test("isThemeRepo：仓库名以 theme/skin/wallpaper 结尾才触发", () => {
  assert.equal(isThemeRepo("o/dsh-theme", "dsh-theme", []), true);
  assert.equal(isThemeRepo("o/open-sea-skin", "open-sea-skin", []), true);
  assert.equal(isThemeRepo("o/dsh-wallpaper", "dsh-wallpaper", []), true);
  assert.equal(isThemeRepo("o/dsh-themes", "dsh-themes", []), true);
  // 只是名字中间含 theme，没有标签时不算
  assert.equal(isThemeRepo("o/dsh-theme-matrix-glass", "dsh-theme-matrix-glass", []), false);
});

test("isThemeRepo：不看 owner 昵称，避免 Nicholaskin 这类误判", () => {
  assert.equal(isThemeRepo("Nicholaskin/vision-exp-tile", "vision-exp-tile", []), false);
});

test("isThemeRepo：fullName 没有斜杠时退回 name 判断", () => {
  assert.equal(isThemeRepo("dsh-skin", "dsh-skin", []), true);
  assert.equal(isThemeRepo("plain", "plain", []), false);
});

test("normalizeRecord：普通插件命中主题线索后归为 theme", () => {
  const entry = normalizeRecord(raw({ tags: ["dsh-theme"] }), new Date("2026-11-03T00:00:00Z"));
  assert.equal(entry?.type, "theme");
});

test("normalizeRecord：skill 不参与主题归并", () => {
  const entry = normalizeRecord(
    raw({ fullName: "o/dsh-theme", name: "dsh-theme", type: "skill", tags: ["dsh-theme"] }),
    new Date("2026-11-03T00:00:00Z"),
  );
  assert.equal(entry?.type, "skill");
});

test("normalizeRecord：没有主题线索时保持 cordis-plugin", () => {
  const entry = normalizeRecord(raw(), new Date("2026-11-03T00:00:00Z"));
  assert.equal(entry?.type, "cordis-plugin");
});

test("normalizeRecord：上游未知类型不会因主题线索变成 theme", () => {
  const entry = normalizeRecord(
    raw({ type: "weird", tags: ["theme"] }),
    new Date("2026-11-03T00:00:00Z"),
  );
  assert.equal(entry?.type, "unknown");
});
