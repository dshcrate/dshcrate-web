import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginEntry } from "@dsh-crate/schema";
import { DATA_DIR } from "./config.ts";

/**
 * 补全并刷新插件自身版本号（不是 dsh 兼容范围）。
 *
 * 三条来源，按可靠度排序：
 *   1. 安装规格里钉死的版本（`add foo@0.5.6`）—— 装上去就是这个版本，直接用；
 *   2. npm registry 的 latest（`add foo` / `add foo@latest`）；
 *   3. 没有 npm 规格的（`github:owner/repo` 或上游压根没写安装命令）读仓库根 package.json。
 *
 * 缓存：`.data/versions-cache.json`，形如
 * `{ "npm:dshmarket": { "v": "1.73.16", "t": "2026-11-09" } }`。
 * TTL 取 1 天，和每日构建对齐：每个包每天重查一次，过期的才发请求。
 * 请求带 User-Agent（npm 端点对无 UA 的客户端容易直接 429）；限流/服务端/网络失败
 * 会重试一次（限流等 2s，其余 500ms），404 这类确定性失败不重试。
 * 失败按「无版本 / 限流 / 网络」分类统计并打出样例，重试后仍失败则保留上一轮版本。
 */

const REGISTRY = "https://registry.npmjs.org";
const RAW = "https://raw.githubusercontent.com";
/**
 * 并发按域名拆开：npm registry 限流更严，压到 8；raw.githubusercontent 宽松些，保持 24。
 * 两池并行跑，互不拖慢。
 */
const NPM_CONCURRENCY = 8;
const RAW_CONCURRENCY = 24;
const TIMEOUT_MS = 8000;
/** 普通失败重试前的等待时间。 */
const RETRY_DELAY_MS = 500;
/** 被限流（429）时多等一会儿再试。 */
const THROTTLE_DELAY_MS = 2000;
/** 构建日志里最多展示的失败样例数。 */
const SAMPLE_LIMIT = 5;
/** 沿用 downloads.ts 的 UA：npm 端点对无 UA 请求会成片 429。 */
const USER_AGENT = "dsh-crate-collector/1.0 (+https://dshcrate.com)";
const DAY = 86_400_000;
/** 版本缓存有效期：站点每天构建一次，正好让每个包每天刷新一次。 */
const TTL_DAYS = 1;
const CACHE_FILE = "versions-cache.json";

type Spec =
  | { kind: "exact"; version: string }
  | { kind: "npm"; pkg: string }
  | { kind: "github"; owner: string; repo: string }
  | null;

/** 需要联网查询的两种规格；`exact` 不在此列。 */
type LookupSpec = Exclude<NonNullable<Spec>, { kind: "exact" }>;

/** 查询失败分类：missing=确实查不到版本；throttled=限流；unreachable=网络/服务端异常。 */
type FailureKind = "missing" | "throttled" | "unreachable";

const EXACT = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;
/** 合法 npm 包名（可带 scope）；历史脏数据（中文说明、<目录>、owner/repo）不查。 */
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/** 单个域名的查询分类计数。 */
export interface HostStats {
  queried: number;
  missing: number;
  throttled: number;
  unreachable: number;
}

/** 版本号刷新统计。 */
export interface VersionResolveResult {
  /** 最终带版本号的条目数。 */
  hits: number;
  /** 直接命中缓存的条目数。 */
  cached: number;
  /** 实际查询的包数（npm 包名或仓库）。 */
  queried: number;
  /** 上游确实没有可查版本（404 / package.json 缺 version）。 */
  missing: number;
  /** 重试后仍被限流（429）。 */
  throttled: number;
  /** 重试后仍网络失败或服务端异常。 */
  unreachable: number;
  /** 失败样例（key#原因），最多 5 条，供构建日志定位。 */
  samples: string[];
  /** 按域名拆开的分类计数：npm=registry.npmjs.org，raw=raw.githubusercontent.com。 */
  byHost: { npm: HostStats; raw: HostStats };
}

interface CacheRow {
  /** version */
  v: string;
  /** 查询日期 YYYY-MM-DD */
  t: string;
}

type Cache = Record<string, CacheRow>;

function parseSpec(spec: string | null): Spec {
  if (!spec) return null;

  const gh = spec.match(/^github:([^/#]+)\/([^/#]+)/);
  if (gh) return { kind: "github", owner: gh[1]!, repo: gh[2]!.replace(/\.git$/, "") };

  // git+/https/本地路径之类没有可查的发布版本
  if (/^(git\+|https?:|link:|file:|\.|\/)/.test(spec)) return null;

  // scoped 包 @a/b 的第一个 @ 是前缀，版本分隔符只可能在 index>0 的位置
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : "";
  if (!name) return null;
  // 不是合法 npm 名（`<目录`、`只装不构建）`、`owner/repo` 之类）就别发请求，回退读仓库。
  if (!NPM_NAME.test(name)) return null;

  if (EXACT.test(range)) return { kind: "exact", version: range.replace(/^v/, "") };
  return { kind: "npm", pkg: name };
}

/** 单次请求结果；failure 非空表示失败原因。 */
interface Attempt {
  body: Record<string, unknown> | null;
  failure: FailureKind | null;
}

/** 按 HTTP 状态归类：404/410 是「确实没有」，429 是限流，其余都算网络/服务端异常。 */
function classify(status: number): FailureKind {
  if (status === 404 || status === 410) return "missing";
  if (status === 429) return "throttled";
  return "unreachable";
}

/** 发一次请求。 */
async function attempt(url: string): Promise<Attempt> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { body: null, failure: classify(res.status) };
    return { body: (await res.json()) as Record<string, unknown>, failure: null };
  } catch {
    return { body: null, failure: "unreachable" };
  }
}

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

/** 取 JSON；限流/服务端/网络失败重试一次，404 等确定性失败不重试。 */
async function fetchJson(url: string): Promise<Attempt> {
  const first = await attempt(url);
  if (first.body !== null || first.failure === null || first.failure === "missing") return first;
  await sleep(first.failure === "throttled" ? THROTTLE_DELAY_MS : RETRY_DELAY_MS);
  return attempt(url);
}

const latestVersion = async (pkg: string): Promise<{ version: string | null; failure: FailureKind | null }> => {
  const result = await fetchJson(`${REGISTRY}/${pkg.replace("/", "%2F")}/latest`);
  const v = result.body?.["version"];
  if (typeof v === "string") return { version: v, failure: null };
  return { version: null, failure: result.failure ?? "missing" };
};

const repoVersion = async (owner: string, repo: string): Promise<{ version: string | null; failure: FailureKind | null }> => {
  const result = await fetchJson(`${RAW}/${owner}/${repo}/HEAD/package.json`);
  if (result.body === null) return { version: null, failure: result.failure ?? "missing" };
  const v = result.body["version"];
  if (typeof v !== "string") return { version: null, failure: "missing" };
  // monorepo 根 package.json 常写成 0.0.0 占位，这种不算版本
  return /^0\.0\.0?$/.test(v) ? { version: null, failure: "missing" } : { version: v, failure: null };
};

/** 读取缓存；文件缺失或损坏都当作空缓存。 */
function loadCache(dir: string): Cache {
  const file = resolve(dir, CACHE_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Cache) : {};
  } catch {
    return {};
  }
}

function saveCache(dir: string, cache: Cache): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, CACHE_FILE), JSON.stringify(cache), "utf8");
}

function isFresh(day: string): boolean {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < TTL_DAYS * DAY;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 条目对应的查询目标：npm 包名或仓库，兼顾「没写 npm 规格」的兜底。 */
function targetOf(entry: PluginEntry): { key: string; spec: LookupSpec } {
  const spec = parseSpec(entry.install.packageName);
  if (spec !== null && spec.kind !== "exact") {
    const key = spec.kind === "npm" ? `npm:${spec.pkg}` : `gh:${spec.owner}/${spec.repo}`;
    return { key, spec };
  }
  // 没写 npm 规格：退回仓库本身
  const slash = entry.fullName.indexOf("/");
  const owner = entry.fullName.slice(0, slash);
  const repo = entry.fullName.slice(slash + 1);
  return { key: `gh:${owner}/${repo}`, spec: { kind: "github", owner, repo } };
}

interface PendingGroup {
  key: string;
  spec: LookupSpec;
  entries: PluginEntry[];
}

/** 单池统计；samples 只在限流/网络失败时记录。 */
interface RefreshStats extends HostStats {
  samples: string[];
}

function emptyStats(): RefreshStats {
  return { queried: 0, missing: 0, throttled: 0, unreachable: 0, samples: [] };
}

/** 去掉样例，只留计数，供 byHost 使用。 */
function hostStats(stats: RefreshStats): HostStats {
  return {
    queried: stats.queried,
    missing: stats.missing,
    throttled: stats.throttled,
    unreachable: stats.unreachable,
  };
}

/** 单池并发消费：固定并发数，直到队列取空。 */
async function runPool(groups: PendingGroup[], concurrency: number, cache: Cache): Promise<RefreshStats> {
  const stats = emptyStats();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
    while (cursor < groups.length) {
      const group = groups[cursor]!;
      cursor += 1;
      stats.queried += 1;
      const spec = group.spec;
      const { version, failure } = spec.kind === "npm"
        ? await latestVersion(spec.pkg)
        : await repoVersion(spec.owner, spec.repo);
      if (version === null) {
        const kind: FailureKind = failure ?? "missing";
        stats[kind] += 1;
        if (kind !== "missing" && stats.samples.length < SAMPLE_LIMIT) {
          stats.samples.push(`${group.key}#${kind}`);
        }
        continue;
      }
      for (const entry of group.entries) entry.version = version;
      cache[group.key] = { v: version, t: today() };
    }
  });
  await Promise.all(workers);
  return stats;
}

/** npm 与 raw 分池并发刷新过期分组；返回各池统计与合并结果。 */
async function refreshPending(
  pending: PendingGroup[],
  cache: Cache,
): Promise<{ npm: RefreshStats; raw: RefreshStats; merged: RefreshStats }> {
  const npm: PendingGroup[] = [];
  const raw: PendingGroup[] = [];
  for (const group of pending) {
    if (group.spec.kind === "npm") npm.push(group);
    else raw.push(group);
  }
  const [npmStats, rawStats] = await Promise.all([
    runPool(npm, NPM_CONCURRENCY, cache),
    runPool(raw, RAW_CONCURRENCY, cache),
  ]);
  const merged: RefreshStats = {
    queried: npmStats.queried + rawStats.queried,
    missing: npmStats.missing + rawStats.missing,
    throttled: npmStats.throttled + rawStats.throttled,
    unreachable: npmStats.unreachable + rawStats.unreachable,
    samples: [...npmStats.samples, ...rawStats.samples].slice(0, SAMPLE_LIMIT),
  };
  return { npm: npmStats, raw: rawStats, merged };
}

/** 就地写入 entry.version，过期条目重新查询并回填缓存。 */
export async function resolveVersions(
  entries: PluginEntry[],
  dir: string = DATA_DIR,
): Promise<VersionResolveResult> {
  const cache = loadCache(dir);
  const pending = new Map<string, PendingGroup>();
  let cached = 0;

  for (const entry of entries) {
    const spec = parseSpec(entry.install.packageName);
    if (spec?.kind === "exact") {
      entry.version = spec.version;
      continue;
    }
    const { key, spec: target } = targetOf(entry);
    const row = cache[key];
    if (row !== undefined && typeof row.v === "string" && row.v !== "" && isFresh(row.t)) {
      entry.version = row.v;
      cached += 1;
      continue;
    }
    const group = pending.get(key);
    if (group) group.entries.push(entry);
    else pending.set(key, { key, spec: target, entries: [entry] });
  }

  const { npm, raw, merged } = await refreshPending([...pending.values()], cache);
  if (merged.queried > 0) saveCache(dir, cache);

  const hits = entries.filter(entry => entry.version !== null && entry.version !== "").length;
  return {
    hits,
    cached,
    queried: merged.queried,
    missing: merged.missing,
    throttled: merged.throttled,
    unreachable: merged.unreachable,
    samples: merged.samples,
    byHost: { npm: hostStats(npm), raw: hostStats(raw) },
  };
}
