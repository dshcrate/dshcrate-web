import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, renderLogin, renderStats } from "./api/telemetry-stats.ts";

test("escapes HTML in dashboard data", () => {
  assert.equal(escapeHtml("<script>&\"'"), "&lt;script&gt;&amp;&quot;&#39;");
});

test("shows a login form without data", () => {
  const html = renderLogin();
  assert.match(html, /name="token"/);
  assert.doesNotMatch(html, /今日活跃/);
});

test("renders summary, empty state, and escaped version labels", () => {
  const html = renderStats({
    today: 2,
    week: 5,
    month: 8,
    total: 12,
    daily: [{ day: "2026-11-20", installs: 2 }],
    versions: [{ v: "<bad>", installs: 1 }],
    kinds: [{ kind: "web", installs: 1 }],
    regions: [{ region: "china", installs: 1 }],
    updatedAt: "2026-11-20 10:30",
  });
  assert.match(html, /今日活跃/);
  assert.match(html, /近 7 天/);
  assert.match(html, /2026-11-20/);
  assert.match(html, /&lt;bad&gt;/);
  assert.doesNotMatch(html, /<bad>/);
});

test("renders the empty state when there are no rows", () => {
  const html = renderStats({
    today: 0,
    week: 0,
    month: 0,
    total: 0,
    daily: [],
    versions: [],
    kinds: [],
    regions: [],
    updatedAt: "2026-11-20 10:30",
  });
  assert.match(html, /还没有数据/);
});
