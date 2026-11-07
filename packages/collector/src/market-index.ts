import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PluginEntry, PluginType } from "@dsh-shelfry/schema";

import { DATA_DIR } from "./config.ts";

/** 官方索引格式版本；宿主只认 1。 */
const OFFICIAL_FORMAT = 1;
/** npm registry 根地址。 */
const REGISTRY = "https://registry.npmjs.org";
/** 发布时间缓存文件名，存放在 .data 下，不随产物同步到 web。 */
export const PUBLISH_TIME_CACHE = "npm-publish-times.json";
/** 首次补时间需要抓约 7 千个包，用并发压住总耗时。 */
const CONCURRENCY = 48;
const TIMEOUT_MS = 10_000;
/** 官方构建脚本对描述的上限。 */
const DESCRIPTION_LIMIT = 160;
/** 站内详情页地址前缀。 */
const ORIGIN = "https://shelfry.app";
/** 合法 npm 包名（新包名一律小写）。 */
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
/** 钉死的精确版本，如 1.2.3 / v1.2.3 / 1.2.3-beta.1。 */
const PINNED_VERSION = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;
/** GitHub 用户名规则：字母数字与连字符，最长 39 字符。 */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** 官方顶层分类；条目按自身类型归到这里，必须与 metadata.categories 一致。 */
const CATEGORY_TITLES: Record<string, { title: { en: string; zh: string } }> = {
  plugin: { title: { en: "Plugins", zh: "插件" } },
  theme: { title: { en: "Themes", zh: "主题" } },
  skill: { title: { en: "Skills", zh: "技能" } },
  tool: { title: { en: "Tools", zh: "工具" } },
};

interface OfficialVersion {
  version: string;
  publishTimestamp: number;
  source: { type: "npm" };
}

interface OfficialPlugin {
  name: string;
  title: string;
  description?: string | { en: string; zh?: string };
  icon?: string;
  homepage: string;
  repository: { url: string };
  metadata: { category: string };
  versions: OfficialVersion[];
}

export interface OfficialIndex {
  format: 1;
  title: { en: string; zh: string };
  description: { en: string; zh: string };
  metadata: {
    categories: Record<string, { title: { en: string; zh: string } }>;
  };
  plugins: OfficialPlugin[];
}

export interface OfficialIndexSkipped {
  /** 不是 npm 安装规格（github: / git+ / 本地路径 / 占位包名）。 */
  noNpm: number;
  /** 有 npm 包但拿不到版本号。 */
  noVersion: number;
  /** 拿不到该版本的 npm 发布时间。 */
  noTime: number;
  /** 同一 npm 包重复出现，保留分数更高的一条。 */
  duplicate: number;
}

export type PublishTimeCache = Record<string, Record<string, number>>;

export interface PublishTimesResult {
  times: PublishTimeCache;
  /** 本次实际查询的包数。 */
  queried: number;
  /** 缓存直接命中的条目数。 */
  cached: number;
  /** 查询后仍拿不到的条目数。 */
  missed: number;
}

export interface OfficialIndexResult {
  file: string;
  total: number;
  skipped: OfficialIndexSkipped;
  queried: number;
  cached: number;
  missed: number;
}

/**
 * 从安装规格里取出 npm 包名与钉死的版本。
 * 入参：install.packageName，如 pkg、pkg@1.2.3、@scope/pkg@^2、github:o/r
 * 返回：npm 规格为 { pkg, pinned }；非 npm 规格或占位包名返回 null。
 */
export function npmTargetOf(spec: string | null): { pkg: string; pinned: string | null } | null {
  if (spec === null || spec === "") return null;
  if (spec.startsWith("github:")) return null;
  if (/^(?:git\+|https?:|link:|file:|\.|\/)/.test(spec)) return null;
  // scoped 包名以 @ 开头，版本分隔符要跳过第一个 @
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const pkg = at > 0 ? spec.slice(0, at) : spec;
  const range = at > 0 ? spec.slice(at + 1) : "";
  if (!NPM_NAME.test(pkg)) return null;
  return { pkg, pinned: PINNED_VERSION.test(range) ? range.replace(/^v/, "") : null };
}

/**
 * 按官方构建脚本的口径截断描述：超长时优先在空格处断开，避免英文单词被切半。
 * 入参：原始描述；返回：不超过 160 字的描述。
 */
function truncateDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DESCRIPTION_LIMIT) return trimmed;
  const cut = trimmed.slice(0, DESCRIPTION_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${space > DESCRIPTION_LIMIT - 24 ? cut.slice(0, space) : cut}…`;
}

/**
 * 组装官方要求的描述字段：有英文时给 { en, zh } 对象，只有中文时给字符串。
 * 入参：条目（中文简介 + 上游简介）；返回：官方可接受的 description，两边都空返回 undefined。
 */
function localizedDescription(
  entry: PluginEntry,
): string | { en: string; zh?: string } | undefined {
  const en = entry.description.trim();
  const zh = (entry.descriptionZh ?? "").trim();
  if (en !== "") {
    return zh === "" ? truncateDescription(en) : { en: truncateDescription(en), zh: truncateDescription(zh) };
  }
  return zh === "" ? undefined : truncateDescription(zh);
}

/** 把条目类型映射成官方分类 id。 */
function categoryOf(type: PluginType): string {
  if (type === "cordis-plugin") return "plugin";
  if (type === "theme") return "theme";
  if (type === "skill") return "skill";
  return "tool";
}

/**
 * 生成 GitHub 头像图标地址。
 * 入参：条目 id，GitHub 来源形如 owner/repo
 * 返回：官方索引可用的绝对图标 URL；不是 GitHub 仓库形态返回 undefined。
 */
function githubAvatarIcon(id: string): string | undefined {
  const parts = id.split("/");
  if (parts.length !== 2) return undefined;
  const owner = parts[0];
  if (owner === undefined || !GITHUB_OWNER.test(owner)) return undefined;
  return `https://avatars.githubusercontent.com/${owner}?size=64`;
}

/**
 * 把单条条目映射成官方索引条目。
 * 入参：条目 + 该版本在 npm 的发布时间（整数秒，取不到传 null）
 * 返回：满足官方最低要求的官方条目；缺 npm 包、缺版本或缺时间返回 null。
 */
export function toOfficialPlugin(entry: PluginEntry, publishedAt: number | null): OfficialPlugin | null {
  const target = npmTargetOf(entry.install.packageName);
  if (target === null) return null;
  const version = entry.version ?? target.pinned;
  if (version === null || version === "") return null;
  if (publishedAt === null || !Number.isInteger(publishedAt)) return null;
  const description = localizedDescription(entry);
  const icon = githubAvatarIcon(entry.id);
  return {
    name: target.pkg,
    title: entry.fullName,
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
    homepage: `${ORIGIN}/p/${entry.id}`,
    repository: { url: `https://github.com/${entry.id}` },
    metadata: { category: categoryOf(entry.type) },
    versions: [{ version, publishTimestamp: publishedAt, source: { type: "npm" } }],
  };
}

/**
 * 全量构建官方索引：只保留 npm 包、有版本、有发布时间的条目，其余跳过。
 * 入参：全量条目 + 发布时间缓存
 * 返回：官方索引与跳过原因统计。
 */
export function buildOfficialIndex(
  entries: PluginEntry[],
  times: PublishTimeCache,
): { index: OfficialIndex; skipped: OfficialIndexSkipped } {
  const skipped: OfficialIndexSkipped = { noNpm: 0, noVersion: 0, noTime: 0, duplicate: 0 };
  const picked = new Map<string, { plugin: OfficialPlugin; score: number }>();
  for (const entry of entries) {
    const target = npmTargetOf(entry.install.packageName);
    if (target === null) {
      skipped.noNpm += 1;
      continue;
    }
    const version = entry.version ?? target.pinned;
    if (version === null || version === "") {
      skipped.noVersion += 1;
      continue;
    }
    const publishedAt = times[target.pkg]?.[version] ?? null;
    const plugin = toOfficialPlugin(entry, publishedAt);
    if (plugin === null) {
      skipped.noTime += 1;
      continue;
    }
    const previous = picked.get(target.pkg);
    if (previous !== undefined) {
      skipped.duplicate += 1;
      if (previous.score >= entry.score.total) continue;
    }
    picked.set(target.pkg, { plugin, score: entry.score.total });
  }
  const plugins = [...picked.values()]
    .sort((a, b) => b.score - a.score)
    .map((item) => item.plugin);
  const index: OfficialIndex = {
    format: OFFICIAL_FORMAT,
    title: { en: "Shelfry DSH Plugins", zh: "Shelfry DSH 插件目录" },
    description: {
      en: "DSH plugins indexed by shelfry.app.",
      zh: "shelfry.app 收录的 DSH 插件目录。",
    },
    metadata: { categories: CATEGORY_TITLES },
    plugins,
  };
  return { index, skipped };
}

/**
 * 本地校验官方必需字段，避免把结构不合的文件发给宿主。
 * 入参：构建好的官方索引；返回：无；不合法直接抛错。
 */
export function assertOfficialIndex(index: OfficialIndex): void {
  if (index.format !== OFFICIAL_FORMAT) throw new Error("format 必须为 1");
  if (index.plugins.length === 0) throw new Error("plugins 不能为空");
  for (const plugin of index.plugins) {
    if (plugin.name === "" || plugin.title === "") throw new Error("条目缺 name/title");
    const version = plugin.versions[0];
    if (
      version === undefined ||
      version.version === "" ||
      !Number.isInteger(version.publishTimestamp) ||
      version.source.type !== "npm"
    ) {
      throw new Error(`条目版本信息不完整：${plugin.name}`);
    }
    if (CATEGORY_TITLES[plugin.metadata.category] === undefined) {
      throw new Error(`分类未在 metadata.categories 声明：${plugin.metadata.category}`);
    }
  }
}

/** 读取发布时间缓存；文件缺失或损坏都当作空缓存。 */
function readPublishTimeCache(dir: string): PublishTimeCache {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, PUBLISH_TIME_CACHE), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as PublishTimeCache) : {};
  } catch {
    return {};
  }
}

/** 保存发布时间缓存；只在下发过请求时执行，避免无谓写盘。 */
function writePublishTimeCache(dir: string, cache: PublishTimeCache): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, PUBLISH_TIME_CACHE), JSON.stringify(cache), "utf8");
}

/** 抓单个包的 packument，取出所需版本的发布时间（整数秒）。 */
async function fetchPublishTimes(pkg: string, wanted: Set<string>): Promise<Record<string, number>> {
  try {
    const response = await fetch(`${REGISTRY}/${pkg.replace("/", "%2F")}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return {};
    const body = (await response.json()) as { time?: Record<string, string> };
    const time = body.time ?? {};
    const out: Record<string, number> = {};
    for (const version of wanted) {
      const raw = time[version];
      if (typeof raw !== "string") continue;
      const timestamp = Date.parse(raw);
      if (Number.isFinite(timestamp)) out[version] = Math.floor(timestamp / 1000);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 补齐条目所需版本的 npm 发布时间，带持久缓存，只查缺失的包。
 * 入参：全量条目 + 缓存目录
 * 返回：发布时间表与查询/命中/缺失统计。
 */
export async function resolvePublishTimes(
  entries: PluginEntry[],
  dir: string = DATA_DIR,
): Promise<PublishTimesResult> {
  const cache = readPublishTimeCache(dir);
  const needed = new Map<string, Set<string>>();
  let cached = 0;
  for (const entry of entries) {
    const target = npmTargetOf(entry.install.packageName);
    if (target === null) continue;
    const version = entry.version ?? target.pinned;
    if (version === null || version === "") continue;
    if (cache[target.pkg]?.[version] !== undefined) {
      cached += 1;
      continue;
    }
    const versions = needed.get(target.pkg) ?? new Set<string>();
    versions.add(version);
    needed.set(target.pkg, versions);
  }
  const packages = [...needed.keys()];
  let cursor = 0;
  let queried = 0;
  let missed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < packages.length) {
      const pkg = packages[cursor];
      cursor += 1;
      if (pkg === undefined) return;
      const wanted = needed.get(pkg);
      if (wanted === undefined) continue;
      const hits = await fetchPublishTimes(pkg, wanted);
      queried += 1;
      const row = (cache[pkg] ??= {});
      let hit = 0;
      for (const [version, timestamp] of Object.entries(hits)) {
        row[version] = timestamp;
        hit += 1;
      }
      missed += wanted.size - hit;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, packages.length) }, worker));
  if (queried > 0) writePublishTimeCache(dir, cache);
  return { times: cache, queried, cached, missed };
}

/**
 * 生成官方格式索引并落盘到 dir/index.json。
 * 入参：全量条目 + 输出目录（单测可传临时目录）+ 可选的时间表（传入即跳过联网补时间）
 * 返回：文件路径与统计；一条都不合格时抛错，保留上一次的文件。
 */
export async function writeOfficialIndex(
  entries: PluginEntry[],
  dir: string = DATA_DIR,
  presetTimes?: PublishTimeCache,
): Promise<OfficialIndexResult> {
  const resolved =
    presetTimes === undefined
      ? await resolvePublishTimes(entries, dir)
      : { times: presetTimes, queried: 0, cached: entries.length, missed: 0 };
  const { times, queried, cached, missed } = resolved;
  const { index, skipped } = buildOfficialIndex(entries, times);
  assertOfficialIndex(index);
  const file = resolve(dir, "index.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(index), "utf8");
  return { file, total: index.plugins.length, skipped, queried, cached, missed };
}
