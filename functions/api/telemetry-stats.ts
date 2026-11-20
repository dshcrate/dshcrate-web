/**
 * 匿名使用统计看板（Cloudflare Pages Function，路由 /api/telemetry-stats）。
 *
 * 只读 D1，不写入任何数据；访问需要 TELEMETRY_STATS_TOKEN。
 * 首次通过 ?token=... 进入后会种一个 HttpOnly Cookie，之后直接打开
 * /api/telemetry-stats 即可，不必把口令留在地址栏。
 *
 * 环境变量 / 绑定：
 *   DB                     D1 数据库，表结构见 telemetry/schema.sql
 *   TELEMETRY_STATS_TOKEN  看板访问口令；未配置时整个路由返回 404
 */

interface Env {
  DB?: D1Like;
  TELEMETRY_STATS_TOKEN?: string;
}

interface D1Like {
  prepare(sql: string): D1Statement;
}

interface D1Statement {
  all<T>(): Promise<{ results?: T[] }>;
}

interface Ctx {
  request: Request;
  env: Env;
}

interface CountRow { installs: number }
interface DayRow { day: string; installs: number }
interface VersionRow { v: string; installs: number }
interface KindRow { kind: string; installs: number }
interface RegionRow { region: string; installs: number }

export interface Stats {
  today: number;
  week: number;
  month: number;
  total: number;
  daily: DayRow[];
  versions: VersionRow[];
  kinds: KindRow[];
  regions: RegionRow[];
  updatedAt: string;
}

const COOKIE = "dsh_telemetry_stats";
const CSS = `
:root{color-scheme:light;--ink:#16202a;--muted:#667085;--line:#e4e7ec;--bg:#f5f6f8;--card:#fff;--accent:#1f6feb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 20px 48px}
header{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.mark{color:var(--accent);display:flex}
h1{font-size:20px;line-height:1.2;margin:0;flex:1}
.sub{color:var(--muted);font-size:12px;margin:2px 0 0}
.logout{color:var(--muted);font-size:12px;text-decoration:none}
.logout:hover{color:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.card,section{background:var(--card);border:1px solid var(--line);border-radius:12px}
.card{padding:16px}
.card span{display:block;color:var(--muted);font-size:12px}
.card b{display:block;margin-top:4px;font-size:28px;line-height:1.1;letter-spacing:-.02em}
.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:16px;margin-top:16px}
section{padding:16px 18px}
h2{font-size:14px;margin:0 0 12px}
.row{display:grid;grid-template-columns:88px minmax(60px,1fr) 52px;gap:10px;align-items:center;padding:4px 0;font-size:12px}
.rowLabel{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row b{text-align:right;font-variant-numeric:tabular-nums}
.bar{height:8px;background:#eef1f5;border-radius:999px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);border-radius:999px}
.empty{color:var(--muted);font-size:12px;margin:8px 0}
.note{color:var(--muted);font-size:12px;margin-top:16px}
.login{max-width:420px;margin:12vh auto 0}
.login p{color:var(--muted);margin:0 0 16px}
.login input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit}
.login button{margin-top:12px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
@media(max-width:720px){.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
`;

/** 把任意文本转成可安全拼进 HTML 的内容。 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

/** 等长比较，避免口令校验因为提前返回而泄露长度之外的信息。 */
function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/** 从 Cookie 头里取看板口令。 */
function readCookie(header: string | null): string {
  if (header === null) return "";
  const match = /(?:^|;\s*)dsh_telemetry_stats=([^;]*)/.exec(header);
  if (match?.[1] === undefined) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

const MARK = `<svg class="mark" viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true"><rect x=".5" y=".5" width="15" height="15"/><path d="M.5 3.5h12M12.5.5v12M3.5 12.5h12M3.5 3.5v12M6.5 3.5v9M9.5 3.5v9"/></svg>`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

/** 未登录 / 口令错误时的页面。 */
export function renderLogin(message = ""): string {
  const hint = message === "" ? "输入访问口令查看匿名使用统计。" : escapeHtml(message);
  return page("插件箱子 · 使用统计", `<header>${MARK}<div><h1>使用统计</h1><p class="sub">Plugin Crate · anonymous usage count</p></div></header><section class="login"><p>${hint}</p><form method="get" action="/api/telemetry-stats"><input type="password" name="token" autofocus required placeholder="访问口令"><button type="submit">查看</button></form></section>`);
}

/** 把统计值渲染成一行条形图；空数据给出明确提示。 */
function barRows(rows: ReadonlyArray<{ label: string; value: number }>, empty: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  const max = Math.max(1, ...rows.map((row) => row.value));
  return rows.map((row) => `<div class="row"><span class="rowLabel" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><span class="bar"><i style="width:${(row.value / max * 100).toFixed(1)}%"></i></span><b>${row.value}</b></div>`).join("");
}

/** 看板主体。 */
export function renderStats(stats: Stats): string {
  const kindLabel = (kind: string): string => (kind === "desktop" ? "桌面端" : kind === "web" ? "网页端" : kind);
  const regionLabel = (region: string): string => (region === "global" ? "全球" : region === "china" ? "中国" : region);
  const cards = [
    ["今日活跃", stats.today],
    ["近 7 天", stats.week],
    ["近 30 天", stats.month],
    ["累计安装", stats.total],
  ].map(([label, value]) => `<div class="card"><span>${String(label)}</span><b>${value}</b></div>`).join("");
  const daily = barRows(stats.daily.map((row) => ({ label: row.day, value: row.installs })), "还没有数据");
  const versions = barRows(stats.versions.map((row) => ({ label: row.v, value: row.installs })), "还没有数据");
  const kinds = barRows(stats.kinds.map((row) => ({ label: kindLabel(row.kind), value: row.installs })), "还没有数据");
  const regions = barRows(stats.regions.map((row) => ({ label: regionLabel(row.region), value: row.installs })), "还没有数据");
  return page("插件箱子 · 使用统计", `<header>${MARK}<div><h1>使用统计</h1><p class="sub">最近更新 ${escapeHtml(stats.updatedAt)} · UTC</p></div><a class="logout" href="/api/telemetry-stats?logout=1">退出查看</a></header><div class="cards">${cards}</div><div class="grid"><section><h2>最近 30 天日活</h2>${daily}</section><section><h2>近 30 天版本分布</h2>${versions}</section></div><div class="grid"><section><h2>近 30 天平台分布</h2>${kinds}</section><section><h2>近 30 天区域分布</h2>${regions}</section></div><p class="note">只统计主动开启匿名统计的安装；插件默认关闭。每个安装每个 UTC 日最多计一次，跨版本去重时同一安装可能在不同版本各计一次。</p>`);
}

/** 读取所有看板数据；任何一条查询失败都会抛给调用方。 */
async function loadStats(db: D1Like): Promise<Stats> {
  const [daily, today, week, month, total, versions, kinds, regions] = await Promise.all([
    db.prepare("SELECT day, COUNT(*) AS installs FROM pings GROUP BY day ORDER BY day DESC LIMIT 30").all<DayRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE day = date('now')").all<CountRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE day >= date('now','-6 days')").all<CountRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE day >= date('now','-29 days')").all<CountRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings").all<CountRow>(),
    db.prepare("SELECT v, COUNT(DISTINCT id) AS installs FROM pings WHERE day >= date('now','-29 days') GROUP BY v ORDER BY installs DESC").all<VersionRow>(),
    db.prepare("SELECT kind, COUNT(DISTINCT id) AS installs FROM pings WHERE day >= date('now','-29 days') GROUP BY kind ORDER BY installs DESC").all<KindRow>(),
    db.prepare("SELECT region, COUNT(DISTINCT id) AS installs FROM pings WHERE day >= date('now','-29 days') GROUP BY region ORDER BY installs DESC").all<RegionRow>(),
  ]);
  return {
    daily: daily.results ?? [],
    today: Number(today.results?.[0]?.installs ?? 0),
    week: Number(week.results?.[0]?.installs ?? 0),
    month: Number(month.results?.[0]?.installs ?? 0),
    total: Number(total.results?.[0]?.installs ?? 0),
    versions: versions.results ?? [],
    kinds: kinds.results ?? [],
    regions: regions.results ?? [],
    updatedAt: new Date().toISOString().replace("T", " ").slice(0, 16),
  };
}

function htmlResponse(html: string, status = 200, extra: Record<string, string> = {}): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  });
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(html, { status, headers });
}

export async function onRequest({ request, env }: Ctx): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const expected = env.TELEMETRY_STATS_TOKEN;
  if (expected === undefined || expected === "") return new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  if (url.searchParams.get("logout") === "1") {
    return htmlResponse(renderLogin("已退出。"), 200, {
      "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }

  const provided = url.searchParams.get("token") ?? readCookie(request.headers.get("cookie"));
  if (!safeEqual(provided, expected)) {
    return htmlResponse(renderLogin(provided === "" ? "" : "口令不对，请重试。"), 401);
  }
  if (!env.DB) return htmlResponse(renderLogin("服务端未绑定统计数据库。"), 503);

  try {
    const stats = await loadStats(env.DB);
    const headers: Record<string, string> = {};
    if (url.searchParams.has("token")) {
      headers["set-cookie"] = `${COOKIE}=${encodeURIComponent(expected)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
    }
    return htmlResponse(renderStats(stats), 200, headers);
  } catch {
    return htmlResponse(renderLogin("读取统计失败，请稍后再试。"), 503);
  }
}
