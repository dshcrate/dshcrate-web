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
 * 查询失败时保留条目上一轮的版本，缓存也保持原样，下一轮再试。
 */

const REGISTRY = "https://registry.npmjs.org";
const RAW = "https://raw.githubusercontent.com";
const CONCURRENCY = 48;
const TIMEOUT_MS = 8000;
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

const EXACT = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** 版本号刷新统计。 */
export interface VersionResolveResult {
  /** 最终带版本号的条目数。 */
  hits: number;
  /** 直接命中缓存的条目数。 */
  cached: number;
  /** 实际查询的包数（npm 包名或仓库）。 */
  queried: number;
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

  if (EXACT.test(range)) return { kind: "exact", version: range.replace(/^v/, "") };
  return { kind: "npm", pkg: name };
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const latestVersion = async (pkg: string): Promise<string | null> => {
  const body = await fetchJson(`${REGISTRY}/${pkg.replace("/", "%2F")}/latest`);
  const v = body?.["version"];
  return typeof v === "string" ? v : null;
};

const repoVersion = async (owner: string, repo: string): Promise<string | null> => {
  const body = await fetchJson(`${RAW}/${owner}/${repo}/HEAD/package.json`);
  const v = body?.["version"];
  if (typeof v !== "string") return null;
  // monorepo 根 package.json 常写成 0.0.0 占位，这种不算版本
  return /^0\.0\.0?$/.test(v) ? null : v;
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

/** 并发刷新过期分组；返回实际查询的包数。 */
async function refreshPending(pending: PendingGroup[], cache: Cache): Promise<number> {
  let cursor = 0;
  let queried = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const group = pending[cursor]!;
      cursor += 1;
      queried += 1;
      const spec = group.spec;
      const version = spec.kind === "npm"
        ? await latestVersion(spec.pkg)
        : await repoVersion(spec.owner, spec.repo);
      if (version === null) continue;
      for (const entry of group.entries) entry.version = version;
      cache[group.key] = { v: version, t: today() };
    }
  });
  await Promise.all(workers);
  return queried;
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

  const queried = await refreshPending([...pending.values()], cache);
  if (queried > 0) saveCache(dir, cache);

  const hits = entries.filter(entry => entry.version !== null && entry.version !== "").length;
  return { hits, cached, queried };
}
