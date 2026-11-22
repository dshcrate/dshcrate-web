import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml, renderLogin, renderStats, type Stats } from "./api/telemetry-stats.ts";

const series = Array.from({ length: 30 }, (_, index) => ({
  day: index + 1,
  installs: index < 22 ? (index % 4 === 0 ? 0 : 2) : null,
  opened: index < 22 ? (index % 4 === 0 ? 0 : 1) : null,
}));
const previous = Array.from({ length: 30 }, (_, index) => ({
  day: index + 1,
  installs: 1,
  opened: 1,
}));

const baseStats: Stats = {
  monthLabel: "2026 年 11 月",
  monthActive: 5,
  monthOpened: 3,
  lastMonthActive: 4,
  avgDaily: 10 / 22,
  total: 12,
  today: 22,
  series,
  previous,
  versions: [
    { v: "0.6.0", installs: 3 },
    { v: "<bad>", installs: 1 },
  ],
  kinds: [{ kind: "web", installs: 4 }, { kind: "desktop", installs: 1 }],
  regions: [{ region: "china", installs: 3 }, { region: "global", installs: 2 }],
  updatedAt: "2026-11-22 10:30",
};

test("escapes HTML in dashboard data", () => {
  assert.equal(escapeHtml("<script>&\"'"), "&lt;script&gt;&amp;&quot;&#39;");
});

test("shows a login form without data", () => {
  const html = renderLogin();
  assert.match(html, /name="token"/);
  assert.doesNotMatch(html, /本月活跃/);
});

test("renders the monthly dashboard sections and escaped labels", () => {
  const html = renderStats(baseStats, "test-nonce");
  assert.match(html, /本月活跃/);
  assert.match(html, /本月打开/);
  assert.match(html, /打开率/);
  assert.match(html, /日均活跃/);
  assert.match(html, /累计安装/);
  assert.match(html, /趋势分析/);
  assert.match(html, /今天/);
  assert.match(html, /上月/);
  assert.match(html, /平台分布/);
  assert.match(html, /版本分布/);
  assert.match(html, /区域分布/);
  assert.match(html, /chartTooltip/);
  assert.match(html, /ttOpened/);
  assert.match(html, /<script nonce="test-nonce">/);
  assert.match(html, /2026 年 11 月/);
  assert.match(html, /75\.0%/);
  assert.match(html, /25\.0%/);
  assert.match(html, /&lt;bad&gt;/);
  assert.doesNotMatch(html, /<bad>/);
  assert.doesNotMatch(html, /最近 7 日/);
  assert.doesNotMatch(html, /最近 30 日/);
});

test("renders the monthly empty state", () => {
  const zeros = Array.from({ length: 30 }, (_, index) => ({ day: index + 1, installs: 0, opened: 0 }));
  const empty = Array.from({ length: 30 }, (_, index) => ({ day: index + 1, installs: null, opened: null }));
  const html = renderStats({
    ...baseStats,
    monthActive: 0,
    monthOpened: 0,
    lastMonthActive: 0,
    avgDaily: 0,
    total: 0,
    series: empty,
    previous: zeros,
    versions: [],
    kinds: [],
    regions: [],
  });
  assert.match(html, /本月还没有上报数据/);
  assert.match(html, /还没有数据/);
});
