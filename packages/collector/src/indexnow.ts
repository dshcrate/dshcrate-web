/**
 * Bing 主动推送：把新增/实质变更的详情页 URL 提交给 Bing Webmaster API。
 *
 * 为什么不用匿名 IndexNow 端点：CI（GitHub Actions）出口 IP 被 api.indexnow.org
 * 以 403 拒绝，本地同代码同参数却正常；改用带 apikey 的官方 URL Submission API
 * 绕开匿名出口风控。接口限制：单批 500 条、每域名每天 10,000 条（UTC 零点重置）。
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

/** Bing Webmaster URL Submission API，鉴权走 query 里的 apikey。 */
export const BING_SUBMIT_ENDPOINT = "https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch";

/** 单次请求上限，Bing API 规定。 */
export const BING_BATCH_SIZE = 500;

/** 每域名每天的提交上限，Bing API 规定（UTC 零点重置）。 */
export const BING_DAILY_QUOTA = 10_000;

/** 待推送文件：collect 写入，全部成功接收后删除。 */
export const PENDING_FILE = resolve(DATA_DIR, "indexnow-pending.json");

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
export function chunkUrls(urls: readonly string[], size = BING_BATCH_SIZE): string[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`分批大小非法：${size}`);
  const batches: string[][] = [];
  for (let index = 0; index < urls.length; index += size) {
    batches.push([...urls.slice(index, index + size)]);
  }
  return batches;
}

/**
 * 按每日额度切分：超出部分留到下一轮，避免撞到 429。
 * 入参：urls 待推送列表、quota 每日上限
 * 返回：本轮发送与留待下一轮的 URL
 */
export function splitDailyQuota(
  urls: readonly string[],
  quota = BING_DAILY_QUOTA,
): { send: string[]; overflow: string[] } {
  if (!Number.isInteger(quota) || quota < 1) throw new Error(`每日额度非法：${quota}`);
  return { send: [...urls.slice(0, quota)], overflow: [...urls.slice(quota)] };
}

/** 推送参数。fetchImpl / wait 可注入，便于单测。 */
export interface PushOptions {
  apiKey: string;
  siteUrl: string;
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
  const endpoint = `${BING_SUBMIT_ENDPOINT}?apikey=${encodeURIComponent(options.apiKey)}`;
  const body = JSON.stringify({ siteUrl: options.siteUrl, urlList: urls });
  let status = 0;
  for (const delay of [0, 1000, 3000]) {
    if (delay > 0) await wait(delay);
    try {
      const response = await fetchImpl(endpoint, {
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
  if (!options.apiKey.trim()) throw new Error("缺少 Bing Webmaster API key");
  if (!/^https:\/\//i.test(options.siteUrl)) throw new Error(`siteUrl 非法：${options.siteUrl}`);
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
  const urls = readPending(PENDING_FILE);
  if (urls.length === 0) {
    console.log("[indexnow] 无待推送 URL，跳过");
    return;
  }
  if (process.argv.includes("--dry-run")) {
    console.log(`[indexnow] dry-run：待推送 ${urls.length} 条`);
    return;
  }
  const apiKey = (process.env.BING_WEBMASTER_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("[indexnow] 缺少 BING_WEBMASTER_API_KEY，无法提交");
    process.exitCode = 1;
    return;
  }
  const site = loadSiteConfig();
  const { send, overflow } = splitDailyQuota(urls);
  const result = await pushIndexNow({
    apiKey,
    siteUrl: `https://${site.domain}`,
    urls: send,
  });
  const failed = [...result.failed, ...overflow];
  console.log(
    `[indexnow] 接收 ${send.length - result.failed.length} 条 / 批次状态 ${result.statuses.join(",")}${overflow.length > 0 ? ` / 超出日额度 ${overflow.length} 条` : ""}`,
  );
  if (failed.length > 0) {
    writePending(PENDING_FILE, failed);
    console.error(`[indexnow] 失败或顺延 ${failed.length} 条，已保留到下一轮`);
    process.exitCode = 1;
    return;
  }
  rmSync(PENDING_FILE, { force: true });
  console.log("[indexnow] 全部接收，待推送文件已清空");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
