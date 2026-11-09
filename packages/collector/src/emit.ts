import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactIndex, CatalogMeta, LiteEntry, MarketEntry, MarketFile, PluginEntry } from "@dsh-crate/schema";
import { INDEX_SHARD_COUNT, SCHEMA_VERSION, indexShardId, toLiteEntry } from "@dsh-crate/schema";
import { DATA_DIR, WEB_PUBLIC_DATA_DIR } from "./config.ts";

/**
 * 产物生成。目标：首屏只拉「一小片」，全站 13k 条也不拖垮低端机。
 *
 * 产物结构（全部落在 .data/，不进 git）：
 *   lite.json                     浏览切片（短键名，全量，按分数序）—— 搜索用
 *   pages/<NNNN>.json             分页浏览切片 —— 首屏只拉 0000
 *   meta.json                     站点元信息 + 三档计数
 *   catalog/<NNN>.json            明细分片（详情页按需拉）
 *   index/<NNN>.json              倒排索引分片（token 哈希落片，搜索时只载命中片）
 *   artifacts.json                产物清单（web 先读它，再按需拉具体片）
 *   market-top.json               插件市场切片（DSH 客户端内嵌面板直连，top N 条）
 *   dsh-crate.json                插件市场全量切片（结构同 market-top，不截断，按 id 去重）
 */

const DETAIL_SHARD_SIZE = 500;
const PAGE_SIZE = 60;
/** 市场切片的默认容量：面板打开即全量加载，再大就失去「轻」的意义。 */
const MARKET_TOP_LIMIT = 2000;


function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

export function buildMeta(
  entries: PluginEntry[],
  collectSource?: CatalogMeta["collectSource"],
): CatalogMeta {
  const types: Record<string, number> = {};
  const sources = new Set<string>();
  let external = 0;
  for (const e of entries) {
    types[e.type] = (types[e.type] ?? 0) + 1;
    if (e.ecosystem === "external") external++;
    for (const s of e.sources) sources.add(s);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    total: entries.length,
    external,
    types,
    sources: [...sources].sort(),
    ...(collectSource ? { collectSource } : {}),
  };
}

/** 浏览切片：全量（搜索用）+ 分页文件（首屏只拉第 0 页）。 */
export function writeLite(entries: PluginEntry[]): { file: string; lite: LiteEntry[]; pages: ArtifactIndex["pages"] } {
  // 镜像/克隆仓只认简介里的明确声明（mirror of / 镜像存档 / 上游删库 …）。
  // 不能用「同名仓库 ≥ N」这类启发式：dsh-memory、dsh-notify 这些通用名下面
  // 大多是各自独立的实现，按名字统计会把正常插件一起打成镜像。
  const mirrorClaim =
    /mirror(?:ed)?\s+(?:of|from)|standalone\s+mirror|镜像(?:存档|备份)|备份镜像|克隆自|上游(?:即将)?删库|原仓库已(?:于[^。；]{0,24})?(?:下架|删除|清空)|(?:全量|完整)镜像[^。；]{0,24}(?:分支|标签|提交|tag)/i;
  const lite = entries.map((e) => {
    const item = toLiteEntry(e);
    if (mirrorClaim.test(e.descriptionZh ?? e.description)) item.dp = 1;
    return item;
  });
  const file = resolve(DATA_DIR, "lite.json");
  writeJson(file, lite);

  for (let start = 0; start < lite.length; start += PAGE_SIZE) {
    const chunk = lite.slice(start, start + PAGE_SIZE);
    writeJson(resolve(DATA_DIR, `pages/${String(start / PAGE_SIZE).padStart(4, "0")}.json`), chunk);
  }

  return {
    file,
    lite,
    pages: {
      size: PAGE_SIZE,
      count: Math.max(1, Math.ceil(lite.length / PAGE_SIZE)),
      filePattern: "pages/{page}.json",
    },
  };
}

/** 明细分片：按分数序切片，详情页只拉对应片。 */
export function writeDetailShards(entries: PluginEntry[]): ArtifactIndex["shards"] {
  const shards: ArtifactIndex["shards"] = [];
  for (let start = 0; start < entries.length; start += DETAIL_SHARD_SIZE) {
    const chunk = entries.slice(start, start + DETAIL_SHARD_SIZE);
    const file = `catalog/${String(start / DETAIL_SHARD_SIZE).padStart(4, "0")}.json`;
    writeJson(resolve(DATA_DIR, file), chunk.map((e) => {
      const { score, ...rest } = e;
      return { ...rest, score };
    }));
    shards.push({ file, from: start, to: start + chunk.length - 1, count: chunk.length });
  }
  return shards;
}

/**
 * 倒排索引分片。
 * 分词：拉丁/数字词（小写，≥2 字符）+ 中文 bigram（单字串退化为单字）。
 * 分片 key = token 前 2 字符；查询时只载相关分片。
 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._-]+/g)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) tokens.add(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
}

export function entryTokens(e: PluginEntry): string[] {
  return tokenize([e.name, e.fullName, e.description, e.descriptionZh ?? "", e.tags.join(" ")].join(" "));
}

export function writeIndexShards(entries: PluginEntry[]): ArtifactIndex["index"] {
  const idx = new Map<string, number[]>();
  entries.forEach((e, i) => {
    for (const tk of entryTokens(e)) {
      const arr = idx.get(tk);
      if (arr) arr.push(i);
      else idx.set(tk, [i]);
    }
  });

  const buckets = new Map<number, Record<string, number[]>>();
  for (const [tk, postings] of idx) {
    const id = indexShardId(tk);
    let bucket = buckets.get(id);
    if (!bucket) { bucket = {}; buckets.set(id, bucket); }
    bucket[tk] = postings;
  }

  const out: ArtifactIndex["index"] = { shardCount: INDEX_SHARD_COUNT, shards: [] };
  for (const [id, bucket] of buckets) {
    const file = `index/${String(id).padStart(3, "0")}.json`;
    writeJson(resolve(DATA_DIR, file), bucket);
    out.shards.push({ id, file, tokens: Object.keys(bucket).length });
  }
  out.shards.sort((a, b) => a.id - b.id);
  return out;
}

export function writeArtifactIndex(index: ArtifactIndex): string {
  const file = resolve(DATA_DIR, "artifacts.json");
  writeJson(file, index);
  return file;
}

export function writeMeta(meta: CatalogMeta): string {
  const file = resolve(DATA_DIR, "meta.json");
  writeJson(file, meta);
  return file;
}

/**
 * 分类清单：把上游 tags 聚合成「分类 chips」用的数据。
 *
 * 为什么要排除一批 tag：dsh / dsh-plugin / deepseek-harness / typescript 这类是
 * 「它是什么」，不是「它能干什么」。全部保留会让分类行挤满同义词，用户仍然无从选择。
 * 只留描述用途的中文/场景标签，并过滤长尾（出现次数太少的分类点进去只有几条）。
 */
const CATEGORY_STOP = new Set([
  "dsh", "dsh-plugin", "dsh-plugins", "dsh-plugin-market", "dsh-bundle",
  "deepseek", "deepseek-harness", "deepseek-harness-plugin", "deepseek-harness-plugins",
  "cordis", "cordis-plugin", "plugin", "plugins", "ai", "agent", "ai-agent", "ai-agents",
  "llm", "typescript", "javascript", "nodejs", "react", "openai", "api", "cli",
]);

const CATEGORY_MIN_COUNT = 20;
const CATEGORY_MAX = 48;
/** 工具数量远小于插件，阈值不能照搬，否则工具页永远没有分类。 */
const TOOL_CATEGORY_MAX = 24;

function writeCategoryFile(entries: PluginEntry[], name: string, minCount: number, max: number): string {
  const tally = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.tags) {
      const key = t.trim();
      if (!key || CATEGORY_STOP.has(key.toLowerCase())) continue;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const list = [...tally.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t, n]) => ({ t, n }));

  const file = resolve(DATA_DIR, name);
  writeJson(file, list);
  return file;
}

/**
 * 分类清单按生态分成两份：插件页与工具页各自的标签规模完全不在一个量级，
 * 混在一张表里工具分类会被插件分类挤掉。
 */
export function writeCategories(entries: PluginEntry[]): string[] {
  return [
    writeCategoryFile(entries.filter((e) => e.ecosystem !== "external"), "categories.json", CATEGORY_MIN_COUNT, CATEGORY_MAX),
    // 工具页条目少，单个标签也算分类会铺满两行无意义的 chips，至少要有两条才成类
    writeCategoryFile(entries.filter((e) => e.ecosystem === "external"), "categories-tools.json", 2, TOOL_CATEGORY_MAX),
  ];
}

/**
 * id → 全局序号 的反查表。
 * 详情页是可分享的独立 URL（#/p/owner/repo），直接打开时手上只有 id；
 * 明细分片是按序号切的，所以需要这张表把 id 翻成序号。仅在直达详情页时加载，约几十 KB。
 */
export function writeIdMap(entries: PluginEntry[]): string {
  const map: Record<string, number> = {};
  entries.forEach((e, i) => { map[e.id] = i; });
  const file = resolve(DATA_DIR, "idmap.json");
  writeJson(file, map);
  return file;
}

/** 把条目映射成市场面板展示用的短键名结构（与 lite 契约保持一致）。 */
function toMarketEntry(e: PluginEntry): MarketEntry {
  return {
    i: e.id,
    n: e.name,
    d: e.descriptionZh ?? e.description,
    s: e.stars,
    sc: e.score.total,
    t: e.type,
    vr: e.version,
    g: e.install.enginesDsh,
    cmd: e.install.command,
  };
}

/**
 * 过滤并排序市场条目的候选集。
 *
 * 入参：entries 全量条目
 * 返回：跳过缺 id 的条目后按综合分、星数、id 排序的新数组（不改动入参顺序）
 */
function sortedMarketEntries(entries: PluginEntry[]): PluginEntry[] {
  return entries
    .filter((e) => e.id)
    .sort((a, b) => b.score.total - a.score.total || b.stars - a.stars || a.id.localeCompare(b.id));
}

/**
 * 挑选市场切片的条目：按综合分降序取前 limit 条，只保留展示字段。
 *
 * 入参：
 * - entries：全量条目（不会被原地排序，调用方可继续用原数组写其他产物）
 * - limit：正整数容量
 * 返回：市场条目数组；缺 id 的条目直接跳过（没有 id 无法生成安装/跳转动作）。
 * 非法 limit 直接抛错，避免静默产出空文件。
 */
export function pickMarketTop(entries: PluginEntry[], limit: number = MARKET_TOP_LIMIT): MarketEntry[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`pickMarketTop：limit 应为正整数，实际 ${String(limit)}`);
  }
  return sortedMarketEntries(entries).slice(0, limit).map(toMarketEntry);
}

/**
 * 挑选全量市场条目：不截断，同一 id 只保留排序最靠前的一条。
 *
 * 入参：entries 全量条目（不会被原地排序）
 * 返回：市场条目数组；重名但 id 不同的条目会保留（同名仓库可能是各自独立的实现）
 */
export function pickMarketAll(entries: PluginEntry[]): MarketEntry[] {
  const seen = new Set<string>();
  const unique: PluginEntry[] = [];
  for (const e of sortedMarketEntries(entries)) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    unique.push(e);
  }
  return unique.map(toMarketEntry);
}

/**
 * 写市场切片文件 data/market-top.json。
 *
 * 入参：
 * - entries：全量条目
 * - limit：容量，默认 top 2000
 * - dir：输出目录，默认 .data（单测传临时目录）
 * 返回：文件绝对路径与实际条数。
 */
export function writeMarketTop(
  entries: PluginEntry[],
  limit: number = MARKET_TOP_LIMIT,
  dir: string = DATA_DIR,
): { file: string; total: number } {
  const picked = pickMarketTop(entries, limit);
  const payload: MarketFile = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    total: picked.length,
    entries: picked,
  };
  const file = resolve(dir, "market-top.json");
  writeJson(file, payload);
  return { file, total: picked.length };
}

/**
 * 写全量市场切片文件 data/dsh-crate.json（结构与 market-top 一致，不截断）。
 *
 * 同时写一份 data/dsh-shelfry.json 兼容副本：0.4.x 客户端仍按旧文件名拉取，
 * 升级完成前不能断。
 *
 * 入参：
 * - entries：全量条目
 * - dir：输出目录，默认 .data（单测传临时目录）
 * 返回：文件绝对路径与实际条数。
 */
export function writeMarketAll(
  entries: PluginEntry[],
  dir: string = DATA_DIR,
): { file: string; total: number } {
  const picked = pickMarketAll(entries);
  const payload: MarketFile = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    total: picked.length,
    entries: picked,
  };
  const file = resolve(dir, "dsh-crate.json");
  writeJson(file, payload);
  writeJson(resolve(dir, "dsh-shelfry.json"), payload);
  return { file, total: picked.length };
}

/** 把产物同步到 web 的 public/data（构建期用；运行时只读静态文件，无需后端）。
 *  catalog.json 是本地 store 的全量副本，明细分片已等价覆盖，不必发给前端；
 *  npm 发布时间缓存只服务于官方索引生成，同样不外发。 */
export function syncToWebPublic(): void {
  rmSync(WEB_PUBLIC_DATA_DIR, { recursive: true, force: true });
  mkdirSync(resolve(WEB_PUBLIC_DATA_DIR, ".."), { recursive: true });
  cpSync(DATA_DIR, WEB_PUBLIC_DATA_DIR, {
    recursive: true,
    filter: (src) =>
      !src.endsWith("/catalog.json") &&
      !src.endsWith("\\catalog.json") &&
      !src.endsWith("/npm-publish-times.json") &&
      !src.endsWith("\\npm-publish-times.json") &&
      !src.endsWith("/versions-cache.json") &&
      !src.endsWith("\\versions-cache.json"),
  });
}
