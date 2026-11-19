import assert from "node:assert/strict";
import { test } from "node:test";

import { detailShouldNoindex } from "./indexing.ts";

test("只有确认未收录的详情页才 noindex", () => {
  assert.equal(detailShouldNoindex("missing"), true);
});

test("加载失败不能等同于未收录，避免超时误伤有效页面", () => {
  assert.equal(detailShouldNoindex("error"), false);
});

test("加载中与正常页面都不输出 noindex", () => {
  assert.equal(detailShouldNoindex("loading"), false);
  assert.equal(detailShouldNoindex("ok"), false);
});
