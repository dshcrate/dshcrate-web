/**
 * 站点 sitemap 生成：索引 + 静态页 + 详情页分片。
 *
 * 规则（与用户约定）：
 * - sitemap.xml 只做索引，第一项是 sitemap-pages.xml（首页/榜单/提交页），
 *   之后按 sitemap-1.xml、sitemap-2.xml… 顺序排列；
 * - 详情页每 3000 条一片，按 firstSeenAt 升序、同时间按 id 升序；
 *   新收录的条目时间更新，自然落在最后一片的末尾，已有分片不会被打乱；
 * - 被删除的条目会让后面的分片整体前移，这是可接受的代价；
 * - /favorites 在 robots.txt 里已禁爬，不进 sitemap。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 站点主域，sitemap 里的 URL 必须与页面 canonical 完全一致。 */
export const SITE_ORIGIN = "https://dshcrate.com";

/** 每个详情页分片的条目上限。 */
export const CHUNK_SIZE = 3000;

/** 静态页分片包含的路径。 */
export const STATIC_PAGES = ["/", "/top", "/submit"] as const;

/** sitemap 生成所需的条目字段。 */
export interface SitemapEntry {
  id: string;
  firstSeenAt?: string | null;
  updatedAt?: string | null;
}

/** 一个待写盘的 sitemap 文件。 */
export interface SitemapFile {
  name: string;
  xml: string;
}

/** XML 文本转义，避免仓库名里的特殊字符破坏文档结构。 */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** 把 ISO 时间切成 sitemap 接受的 YYYY-MM-DD；无法解析时返回空串。 */
export function sitemapDate(value: string | null | undefined): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  return new Date(time).toISOString().slice(0, 10);
}

/** 去重并按 firstSeenAt、id 升序排序，保证分片顺序稳定、新条目落在末尾。 */
export function sortEntries(entries: readonly SitemapEntry[]): SitemapEntry[] {
  const seen = new Map<string, SitemapEntry>();
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) continue;
    if (!seen.has(entry.id)) seen.set(entry.id, entry);
  }
  return [...seen.values()].sort((left, right) => {
    const leftTime = left.firstSeenAt ?? "";
    const rightTime = right.firstSeenAt ?? "";
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** 生成单个 urlset 文档。 */
function urlset(entries: readonly SitemapEntry[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const entry of entries) {
    lines.push("  <url>");
    lines.push(`    <loc>${escapeXml(`${SITE_ORIGIN}/p/${entry.id}`)}</loc>`);
    const lastmod = sitemapDate(entry.updatedAt);
    if (lastmod) lines.push(`    <lastmod>${lastmod}</lastmod>`);
    lines.push("    <changefreq>weekly</changefreq>");
    lines.push("    <priority>0.6</priority>");
    lines.push("  </url>");
  }
  lines.push("</urlset>", "");
  return lines.join("\n");
}

/** 生成静态页分片。 */
export function buildPagesSitemap(lastmod: string): SitemapFile {
  const date = sitemapDate(lastmod);
  const priorities = new Map<string, string>([["/", "1.0"], ["/top", "0.8"], ["/submit", "0.5"]]);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const page of STATIC_PAGES) {
    lines.push("  <url>");
    lines.push(`    <loc>${escapeXml(`${SITE_ORIGIN}${page}`)}</loc>`);
    if (date) lines.push(`    <lastmod>${date}</lastmod>`);
    lines.push(`    <changefreq>${page === "/" ? "daily" : "weekly"}</changefreq>`);
    lines.push(`    <priority>${priorities.get(page) ?? "0.5"}</priority>`);
    lines.push("  </url>");
  }
  lines.push("</urlset>", "");
  return { name: "sitemap-pages.xml", xml: lines.join("\n") };
}

/** 生成全部分片：pages 在前，详情页按 3000 条一片依次编号。 */
export function buildSitemapFiles(entries: readonly SitemapEntry[], lastmod: string): SitemapFile[] {
  const files: SitemapFile[] = [buildPagesSitemap(lastmod)];
  const sorted = sortEntries(entries);
  for (let index = 0; index < sorted.length; index += CHUNK_SIZE) {
    files.push({
      name: `sitemap-${files.length}.xml`,
      xml: urlset(sorted.slice(index, index + CHUNK_SIZE)),
    });
  }
  return files;
}

/** 生成 sitemap 索引，保持传入顺序。 */
export function buildSitemapIndex(files: readonly SitemapFile[], lastmod: string): string {
  const date = sitemapDate(lastmod);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const file of files) {
    lines.push("  <sitemap>");
    lines.push(`    <loc>${SITE_ORIGIN}/${file.name}</loc>`);
    if (date) lines.push(`    <lastmod>${date}</lastmod>`);
    lines.push("  </sitemap>");
  }
  lines.push("</sitemapindex>", "");
  return lines.join("\n");
}

/** 清掉上次生成的 sitemap 文件，避免条目减少后留下空分片。 */
export function cleanSitemaps(outDir: string): void {
  if (!existsSync(outDir)) return;
  for (const name of readdirSync(outDir)) {
    if (/^sitemap(?:-\d+|-pages)?\.xml$/u.test(name)) rmSync(join(outDir, name));
  }
}

/** 读取 catalog 分片与数据生成时间；CI 在 collect 之后调用。 */
export function loadCatalog(dataDir: string): { entries: SitemapEntry[]; lastmod: string } {
  const catalogDir = join(dataDir, "catalog");
  const entries: SitemapEntry[] = [];
  if (existsSync(catalogDir)) {
    for (const name of readdirSync(catalogDir)) {
      if (!name.endsWith(".json")) continue;
      const shard = JSON.parse(readFileSync(join(catalogDir, name), "utf8")) as SitemapEntry[];
      if (Array.isArray(shard)) entries.push(...shard);
    }
  }
  let lastmod = "";
  const full = join(dataDir, "dsh-crate.json");
  if (existsSync(full)) {
    const data = JSON.parse(readFileSync(full, "utf8")) as { generatedAt?: string };
    lastmod = data.generatedAt ?? "";
  }
  if (!lastmod) {
    lastmod = entries.reduce((latest, entry) => (entry.updatedAt && entry.updatedAt > latest ? entry.updatedAt : latest), "");
  }
  return { entries, lastmod };
}

/** 写入分片与索引；返回生成的文件名列表。 */
export function writeSitemaps(outDir: string, files: readonly SitemapFile[], lastmod: string): string[] {
  mkdirSync(outDir, { recursive: true });
  cleanSitemaps(outDir);
  for (const file of files) writeFileSync(join(outDir, file.name), file.xml);
  const indexName = "sitemap.xml";
  writeFileSync(join(outDir, indexName), buildSitemapIndex(files, lastmod));
  return [indexName, ...files.map(file => file.name)];
}

/** CLI：从 public/data 读取，写回 public/。 */
function main(): void {
  const publicDir = join(process.cwd(), "packages/web/public");
  const { entries, lastmod } = loadCatalog(join(publicDir, "data"));
  const files = buildSitemapFiles(entries, lastmod);
  const written = writeSitemaps(publicDir, files, lastmod);
  console.log(`sitemap: ${entries.length} entries, ${files.length} files -> ${written.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
