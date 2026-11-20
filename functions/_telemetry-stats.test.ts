import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, renderLogin, renderStats } from "./api/telemetry-stats.ts";

const baseStats = {
  range: "7" as const,
  rangeLabel: "最近 7 日",
  today: 2,
  week: 5,
  month: 8,
  total: 12,
  rangeActive: 5,
  series: [
    { day: "2026-11-18", installs: 1 },
    { day: "2026-11-19", installs: 2 },
    { day: "2026-11-20", installs: 2 },
  ],
  previous: [
    { day: "2026-11-11", installs: 1 },
    { day: "2026-11-12", installs: 0 },
    { day: "2026-11-13", installs: 1 },
  ],
  versions: [{ v: "<bad>", installs: 1 }],
  kinds: [{ kind: "web", installs: 4 }, { kind: "desktop", installs: 1 }],
  regions: [{ region: "china", installs: 3 }, { region: "global", installs: 2 }],
  updatedAt: "2026-11-20 10:30",
};

test("escapes HTML in dashboard data", () => {
  assert.equal(escapeHtml("<script>&\"'"), "&lt;script&gt;&amp;&quot;&#39;");
});

test("shows a login form without data", () => {
  const html = renderLogin();
  assert.match(html, /name="token"/);
  assert.doesNotMatch(html, /今日活跃/);
});

test("renders the dashboard sections, summary, and escaped labels", () => {
  const html = renderStats(baseStats, "test-nonce");
  assert.match(html, /今日活跃/);
  assert.match(html, /近 7 天/);
  assert.match(html, /趋势分析/);
  assert.match(html, /平台分布/);
  assert.match(html, /版本分布/);
  assert.match(html, /区域分布/);
  assert.match(html, /chartTooltip/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /2026-11-20/);
  assert.match(html, /80\.0%/);
  assert.match(html, /&lt;bad&gt;/);
  assert.doesNotMatch(html, /<bad>/);
});

test("renders the empty state when there are no rows", () => {
  const html = renderStats({
    ...baseStats,
    today: 0,
    week: 0,
    month: 0,
    total: 0,
    rangeActive: 0,
    series: [{ day: "2026-11-20", installs: 0 }],
    previous: [],
    versions: [],
    kinds: [],
    regions: [],
  });
  assert.match(html, /还没有数据/);
  assert.match(html, /这个区间还没有上报数据/);
});
