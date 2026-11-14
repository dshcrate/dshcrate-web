/**
 * IndexNow 增量推送：把新增/实质变更的详情页 URL 主动通知给 Bing。
 *
 * 设计边界：
 * - 只推增量：历史页已由 sitemap 全覆盖，全量重推属于协议不推荐的低质量提交；
 * - 星标、下载量、评分、时间变化不算实质变更，否则每天四万条都会被判成变更；
 * - 推送失败不阻断部署：未成功的 URL 留在待推送文件里，下一轮合并继续。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginEntry } from "@dsh-crate/schema";
import { DATA_DIR, loadSiteConfig } from "./config.ts";

/** IndexNow 接收端点，由它分发给所有参与引擎（Bing / Yandex / Seznam / Naver）。 */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** 单次请求的 URL 上限，协议规定。 */
export const INDEXNOW_BATCH_SIZE = 10_000;

/** 待推送文件：collect 写入，全部成功接收后删除。 */
export const PENDING_FILE = resolve(DATA_DIR, "indexnow-pending.json");

/** key 合法格式：8–128 位十六进制。 */
const KEY_PATTERN = /^[a-f0-9]{8,128}$/i;

/** 待推送文件的结构。 */
export interface PendingFile {
  generatedAt: string;
  urls: string[];
}

/** 增量筛选结果。 */
export interface PendingResult {
  urls: string[];
  added: number;
  changed: number;
  /** 上一轮没有基线（首次运行或缓存丢失），本轮不推，避免一次灌四万条。 */
  skippedNoBaseline: boolean;
}

/**
 * 参与「实质变更」比较的字段。
 * stars / downloads / score / updatedAt / pushedAt 每天都会变，不能算。
 * 入参：插件条目
 * 返回：用于比较的签名字符串
 */
function signature(entry: PluginEntry): string {
  return JSON.stringify({
    name: entry.name,
    description: entry.description,
    descriptionZh: entry.descriptionZh,
    version: entry.version,
    type: entry.type,
    ecosystem: entry.ecosystem,
    curated: entry.curated,
    tags: [...entry.tags].sort(),
    command: entry.install.command,
  });
}

/**
 * 比较上一轮与本轮，产出需要通知搜索引擎的详情页 URL。
 * 入参：prev 上一轮条目、next 本轮最终条目、origin 站点主域
 * 返回：待推送 URL 与新增/变更计数
 */
export function selectIndexNowUrls(
  prev: readonly PluginEntry[],
  next: readonly PluginEntry[],
  origin: string,
): PendingResult {
  // 没有基线就不推：首次上线或缓存丢失时会全量命中，一次四万条属于滥用
  if (prev.length === 0) return { urls: [], added: 0, changed: 0, skippedNoBaseline: true };
  const prevById = new Map(prev.map((entry) => [entry.id, entry]));
  const urls: string[] = [];
  let added = 0;
  let changed = 0;
  for (const entry of next) {
    const old = prevById.get(entry.id);
    if (!old) {
      urls.push(`${origin}/p/${entry.id}`);
      added++;
      continue;
    }
    if (signature(old) !== signature(entry)) {
      urls.push(`${origin}/p/${entry.id}`);
      changed++;
    }
  }
  return { urls, added, changed, skippedNoBaseline: false };
}

/** 合并上一轮没推成功的 URL 与新变更，按出现顺序去重。 */
export function mergePending(existing: readonly string[], fresh: readonly string[]): string[] {
  return [...new Set([...existing, ...fresh])];
}

/**
 * 读取待推送文件。
 * 入参：文件路径
 * 返回：合法 URL 列表；文件缺失或格式损坏时返回空数组
 */
export function readPending(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PendingFile>;
    if (!Array.isArray(parsed.urls)) return [];
    return parsed.urls.filter((url): url is string => typeof url === "string" && url.startsWith("https://"));
  } catch {
    return [];
  }
}

/**
 * 写入待推送文件（不存在时自动建目录）。
 * 入参：file 路径、urls 待推送列表、now 当前时间
 * 返回：写入的文件路径
 */
export function writePending(file: string, urls: readonly string[], now = new Date()): string {
  mkdirSync(dirname(file), { recursive: true });
  const payload: PendingFile = { generatedAt: now.toISOString(), urls: [...urls] };
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

/**
 * 按协议上限分批。
 * 入参：urls 全量 URL、size 每批上限
 * 返回：二维批次数组
 */
export function chunkUrls(urls: readonly string[], size = INDEXNOW_BATCH_SIZE): string[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`分批大小非法：${size}`);
  const batches: string[][] = [];
  for (let index = 0; index < urls.length; index += size) {
    batches.push([...urls.slice(index, index + size)]);
  }
  return batches;
}

/** 推送参数。fetchImpl / wait 可注入，便于单测。 */
export interface PushOptions {
  host: string;
  key: string;
  keyLocation: string;
  urls: readonly string[];
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

/** 推送结果。 */
export interface PushResult {
  /** 每批最终状态码（网络错误记 0）。 */
  statuses: number[];
  /** 最终未成功的 URL，留给下一轮。 */
  failed: string[];
}

/** 推送一批；429/5xx/网络错误重试三次（1s、3s），其余 4xx 直接返回。 */
async function postBatch(options: PushOptions, urls: string[]): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const body = JSON.stringify({
    host: options.host,
    key: options.key,
    keyLocation: options.keyLocation,
    urlList: urls,
  });
  let status = 0;
  for (const delay of [0, 1000, 3000]) {
    if (delay > 0) await wait(delay);
    try {
      const response = await fetchImpl(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body,
      });
      status = response.status;
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) return status;
    if (status !== 0 && status !== 429 && status < 500) return status;
  }
  return status;
}

/** 分批推送全部 URL，返回每批状态与失败列表。 */
export async function pushIndexNow(options: PushOptions): Promise<PushResult> {
  const statuses: number[] = [];
  const failed: string[] = [];
  for (const batch of chunkUrls(options.urls)) {
    const status = await postBatch(options, batch);
    statuses.push(status);
    if (status < 200 || status >= 300) failed.push(...batch);
  }
  return { statuses, failed };
}

/** CLI：读取待推送文件并提交；--dry-run 只打印条数。 */
async function main(): Promise<void> {
  const site = loadSiteConfig();
  const key = site.indexNowKey.trim();
  if (!KEY_PATTERN.test(key)) {
    console.error(`[indexnow] indexNowKey 不合法（需 8–128 位十六进制）：${key || "空"}`);
    process.exitCode = 1;
    return;
  }
  const urls = readPending(PENDING_FILE);
  if (urls.length === 0) {
    console.log("[indexnow] 无待推送 URL，跳过");
    return;
  }
  if (process.argv.includes("--dry-run")) {
    console.log(`[indexnow] dry-run：待推送 ${urls.length} 条`);
    return;
  }
  const result = await pushIndexNow({
    host: site.domain,
    key,
    keyLocation: `https://${site.domain}/${key}.txt`,
    urls,
  });
  console.log(`[indexnow] 接收 ${urls.length - result.failed.length} 条 / 批次状态 ${result.statuses.join(",")}`);
  if (result.failed.length > 0) {
    writePending(PENDING_FILE, result.failed);
    console.error(`[indexnow] 失败 ${result.failed.length} 条，已保留到下一轮`);
    process.exitCode = 1;
    return;
  }
  rmSync(PENDING_FILE, { force: true });
  console.log("[indexnow] 全部接收，待推送文件已清空");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
