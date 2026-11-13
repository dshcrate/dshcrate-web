import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHUNK_SIZE,
  buildSitemapFiles,
  buildSitemapIndex,
  escapeXml,
  sitemapDate,
  sortEntries,
  type SitemapEntry,
} from "./sitemap.ts";

/** 造 n 条按 firstSeenAt 递增的条目。 */
function entries(count: number): SitemapEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `owner/repo-${String(index).padStart(4, "0")}`,
    firstSeenAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    updatedAt: "2026-01-02T00:00:00.000Z",
  }));
}

test("escapeXml：五个 XML 特殊字符都转义", () => {
  assert.equal(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

test("sitemapDate：合法时间取日期，非法返回空串", () => {
  assert.equal(sitemapDate("2026-11-12T23:47:38.937Z"), "2026-11-12");
  assert.equal(sitemapDate(""), "");
  assert.equal(sitemapDate("not-a-date"), "");
});

test("sortEntries：按 firstSeenAt 升序、同时间按 id 升序并去重", () => {
  const sorted = sortEntries([
    { id: "b/repo", firstSeenAt: "2026-01-02T00:00:00.000Z" },
    { id: "a/repo", firstSeenAt: "2026-01-01T00:00:00.000Z" },
    { id: "a/repo", firstSeenAt: "2026-01-01T00:00:00.000Z" },
    { id: "c/repo", firstSeenAt: "2026-01-02T00:00:00.000Z" },
  ]);
  assert.deepEqual(sorted.map(entry => entry.id), ["a/repo", "b/repo", "c/repo"]);
});

test("buildSitemapFiles：pages 在前，其后每 3000 条一片", () => {
  const files = buildSitemapFiles(entries(CHUNK_SIZE * 2 + 1), "2026-11-12T23:47:38.937Z");
  assert.deepEqual(files.map(file => file.name), [
    "sitemap-pages.xml",
    "sitemap-1.xml",
    "sitemap-2.xml",
    "sitemap-3.xml",
  ]);
  assert.equal((files[1]!.xml.match(/<url>/gu) ?? []).length, CHUNK_SIZE);
  assert.equal((files[3]!.xml.match(/<url>/gu) ?? []).length, 1);
  assert.ok(files[0]!.xml.includes("https://dshcrate.com/top"));
  assert.ok(!files[0]!.xml.includes("/favorites"));
});

test("新增条目排在最后一片末尾，已有分片不变", () => {
  const base = entries(CHUNK_SIZE + 1);
  const before = buildSitemapFiles(base, "2026-11-12");
  const added: SitemapEntry = { id: "zzz/new", firstSeenAt: "2027-01-01T00:00:00.000Z" };
  const after = buildSitemapFiles([...base, added], "2026-11-13");
  assert.equal(before[1]!.xml, after[1]!.xml);
  const lastChunk = after.at(-1)!.xml;
  assert.ok(lastChunk.indexOf("zzz/new") > lastChunk.indexOf("owner/repo-3000"));
  assert.equal((lastChunk.match(/<url>/gu) ?? []).length, 2);
});

test("详情页 URL 用 /p/<id> 且特殊字符被转义", () => {
  const files = buildSitemapFiles([{ id: "a&b/c", updatedAt: "2026-11-12T00:00:00.000Z" }], "2026-11-12");
  const chunk = files.at(-1)!.xml;
  assert.ok(chunk.includes("<loc>https://dshcrate.com/p/a&amp;b/c</loc>"));
  assert.ok(chunk.includes("<lastmod>2026-11-12</lastmod>"));
});

test("索引按传入顺序列出分片", () => {
  const files = buildSitemapFiles(entries(CHUNK_SIZE + 1), "2026-11-12");
  const index = buildSitemapIndex(files, "2026-11-12");
  const order = [...index.matchAll(/<loc>https:\/\/dshcrate\.com\/([^<]+)<\/loc>/gu)].map(match => match[1]);
  assert.deepEqual(order, ["sitemap-pages.xml", "sitemap-1.xml", "sitemap-2.xml"]);
});
