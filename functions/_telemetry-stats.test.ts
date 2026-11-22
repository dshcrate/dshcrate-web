import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, renderLogin, renderStats, type Stats } from "./api/telemetry-stats.ts";

const week = [
  { day: "2026-11-16", installs: 1, opened: 1 },
  { day: "2026-11-17", installs: 1, opened: 1 },
  { day: "2026-11-18", installs: 2, opened: 1 },
  { day: "2026-11-19", installs: 1, opened: 1 },
  { day: "2026-11-20", installs: 2, opened: 1 },
  { day: "2026-11-21", installs: 2, opened: 2 },
  { day: "2026-11-22", installs: 1, opened: 1 },
];

const baseStats: Stats = {
  range: "7",
  rangeLabel: "最近 7 日",
  rangeActive: 5,
  rangeOpened: 3,
  previousActive: 4,
  avgDaily: 10 / 7,
  total: 12,
  series: week,
  previous: week.map((row, index) => ({ ...row, day: `2026-11-${String(9 + index).padStart(2, "0")}` })),
  context: week,
  versions: [
    { v: "0.6.0", installs: 3 },
    { v: "<bad>", installs: 1 },
  ],
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
  assert.match(html, /区间活跃/);
  assert.match(html, /区间打开/);
  assert.match(html, /打开率/);
  assert.match(html, /日均活跃/);
  assert.match(html, /累计安装/);
  assert.match(html, /趋势分析/);
  assert.match(html, /平台分布/);
  assert.match(html, /版本分布/);
  assert.match(html, /区域分布/);
  assert.match(html, /chartTooltip/);
  assert.match(html, /ttOpened/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /2026-11-22/);
  assert.match(html, /75\.0%/);
  assert.match(html, /25\.0%/);
  assert.match(html, /&lt;bad&gt;/);
  assert.doesNotMatch(html, /<bad>/);
});

test("renders the empty state when there are no rows", () => {
  const zeros = Array.from({ length: 7 }, (_, index) => ({
    day: `2026-11-${String(16 + index).padStart(2, "0")}`,
    installs: 0,
    opened: 0,
  }));
  const html = renderStats({
    ...baseStats,
    rangeActive: 0,
    rangeOpened: 0,
    previousActive: 0,
    avgDaily: 0,
    total: 0,
    series: zeros,
    previous: [],
    context: zeros,
    versions: [],
    kinds: [],
    regions: [],
  });
  assert.match(html, /还没有数据/);
  assert.match(html, /这个区间还没有上报数据/);
});

test("renders the compact single-day view for today", () => {
  const html = renderStats({
    ...baseStats,
    range: "today",
    rangeLabel: "今日",
    rangeActive: 4,
    rangeOpened: 4,
    previousActive: 2,
    avgDaily: 4,
    series: [{ day: "2026-11-22", installs: 4, opened: 4 }],
    previous: [],
  });
  assert.match(html, /今日活跃/);
  assert.match(html, /singleDay/);
  assert.match(html, /近 7 日/);
  assert.match(html, /打开率 100\.0%/);
});

test("labels the previous day as 昨日 and does not call it 今日", () => {
  const html = renderStats({
    ...baseStats,
    range: "yesterday",
    rangeLabel: "昨日",
    rangeActive: 2,
    rangeOpened: 2,
    previousActive: 1,
    avgDaily: 2,
    series: [{ day: "2026-11-21", installs: 2, opened: 2 }],
    previous: [],
  });
  assert.match(html, /昨日活跃/);
  assert.doesNotMatch(html, /今日活跃/);
});
