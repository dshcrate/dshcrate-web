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

export type RangeKey = "today" | "yesterday" | "7" | "30";

export interface Stats {
  range: RangeKey;
  rangeLabel: string;
  today: number;
  week: number;
  month: number;
  total: number;
  rangeActive: number;
  series: DayRow[];
  previous: DayRow[];
  versions: VersionRow[];
  kinds: KindRow[];
  regions: RegionRow[];
  updatedAt: string;
}

interface RangeConfig {
  label: string;
  length: number;
  filter: string;
  previous?: { filter: string };
}

const RANGES: Record<RangeKey, RangeConfig> = {
  today: { label: "今日", length: 1, filter: "day = date('now')" },
  yesterday: { label: "昨日", length: 1, filter: "day = date('now','-1 day')" },
  "7": {
    label: "最近 7 日",
    length: 7,
    filter: "day >= date('now','-6 days')",
    previous: { filter: "day >= date('now','-13 days') AND day <= date('now','-7 days')" },
  },
  "30": {
    label: "最近 30 日",
    length: 30,
    filter: "day >= date('now','-29 days')",
    previous: { filter: "day >= date('now','-59 days') AND day <= date('now','-30 days')" },
  },
};

const COOKIE = "dsh_telemetry_stats";
const CSS = `
:root{color-scheme:light;--ink:#172033;--muted:#6b7280;--faint:#98a2b3;--line:#e7ecf2;--bg:#f5f7fa;--card:#fff;--blue:#2563eb;--orange:#f59e0b;--green:#12b76a;--slate:#64748b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 20px 48px}
.topbar{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px;flex:1}
.mark{color:var(--blue);display:flex;flex:none}
h1{font-size:20px;line-height:1.2;margin:0;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:12px;margin:3px 0 0}
.meta{display:flex;align-items:center;gap:14px;color:var(--faint);font-size:12px;white-space:nowrap}
.meta a{color:var(--muted);text-decoration:none}
.meta a:hover{color:var(--blue)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.tab{padding:7px 14px;border-radius:999px;color:var(--muted);text-decoration:none;font-size:13px;border:1px solid transparent}
.tab:hover{background:#fff;border-color:var(--line);color:var(--ink)}
.tab.on{background:var(--blue);color:#fff;box-shadow:0 4px 12px rgba(37,99,235,.22)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 16px;display:flex;gap:12px;align-items:center;box-shadow:0 1px 2px rgba(16,24,40,.03)}
.kpiIcon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:none}
.kpiIcon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.kpi:nth-child(1) .kpiIcon{background:#eaf1ff;color:var(--blue)}
.kpi:nth-child(2) .kpiIcon{background:#fff5e6;color:var(--orange)}
.kpi:nth-child(3) .kpiIcon{background:#e8f8f1;color:var(--green)}
.kpi:nth-child(4) .kpiIcon{background:#eef2f6;color:var(--slate)}
.kpiLabel{display:block;color:var(--muted);font-size:12px}
.kpi b{display:block;font-size:25px;line-height:1.15;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi small{color:var(--faint);font-size:11px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 2px rgba(16,24,40,.03);padding:16px 18px}
.mainGrid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(280px,.75fr);gap:14px}
.lowerGrid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:14px;margin-top:14px}
.cardHead{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.cardHead h2{font-size:14px;margin:0;line-height:1.4}
.cardHead p{color:var(--muted);font-size:12px;margin:2px 0 0}
.legend{margin-left:auto;display:flex;align-items:center;gap:14px;color:var(--muted);font-size:12px;white-space:nowrap}
.legend i{display:inline-block;width:8px;height:8px;border-radius:999px;margin-right:5px}
.legend .blue{background:var(--blue)}
.legend .orange{background:var(--orange)}
.chart{width:100%;height:auto;display:block}
.chart text{font-size:10px;fill:var(--faint)}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .axis{fill:var(--faint)}
.chart .current{fill:none;stroke:var(--blue);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.chart .previous{fill:none;stroke:var(--orange);stroke-width:1.8;stroke-dasharray:5 5;stroke-linecap:round;stroke-linejoin:round}
.chart .point{fill:#fff;stroke:var(--blue);stroke-width:2;pointer-events:none}
.chart .pointPrev{fill:#fff;stroke:var(--orange);stroke-width:1.6;pointer-events:none}
.chartWrap{position:relative}
.chart .guide{stroke:#cbd5e1;stroke-width:1;stroke-dasharray:4 4;display:none}
.chartTooltip{position:absolute;z-index:5;min-width:196px;padding:12px 14px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 28px rgba(16,24,40,.14);pointer-events:none;font-size:12px;line-height:1.5}
.chartTooltip[hidden]{display:none}
.ttTop{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}
.ttDate{font-weight:600;color:var(--ink)}
.ttDelta{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ttDelta.up{color:#e5484d}
.ttDelta.down{color:var(--green)}
.ttDelta.flat{color:var(--muted)}
.ttRow{display:flex;align-items:center;gap:8px;margin-top:5px;color:var(--muted)}
.ttRow i{width:8px;height:8px;border-radius:999px;flex:none}
.ttRow i.blue{background:var(--blue)}
.ttRow i.orange{background:var(--orange)}
.ttRow b{margin-left:auto;color:var(--ink);font-variant-numeric:tabular-nums}
.platform{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:end;min-height:170px;padding:6px 8px 0}
.vbarItem{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:7px;min-width:0}
.vbarItem b{font-size:13px;font-variant-numeric:tabular-nums}
.vbarTrack{height:126px;width:58px;display:flex;align-items:flex-end;justify-content:center}
.vbarTrack i{display:block;width:100%;border-radius:8px 8px 3px 3px;min-height:4px}
.vbarItem span{color:var(--muted);font-size:12px}
.blueBar{background:linear-gradient(180deg,#60a5fa,#2563eb)}
.orangeBar{background:linear-gradient(180deg,#fbbf24,#f59e0b)}
.miniGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.mini{border-radius:12px;padding:12px;background:#f8fafc;border:1px solid var(--line)}
.mini span{display:block;color:var(--muted);font-size:11px}
.mini b{display:block;font-size:22px;line-height:1.2;margin-top:3px;font-variant-numeric:tabular-nums}
.mini.blue b{color:var(--blue)}
.mini.orange b{color:var(--orange)}
.barList{display:flex;flex-direction:column;gap:9px}
.barRow{display:grid;grid-template-columns:minmax(68px,1fr) minmax(70px,2.2fr) minmax(82px,auto);gap:10px;align-items:center;font-size:12px}
.barLabel{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.barTrack{height:8px;background:#eef2f7;border-radius:999px;overflow:hidden}
.barTrack i{display:block;height:100%;border-radius:999px;background:var(--blue)}
.barValue{text-align:right;color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.barValue small{color:var(--faint);margin-left:3px}
.emptyState{color:var(--muted);font-size:12px;padding:38px 0;text-align:center}
.note{color:var(--faint);font-size:12px;margin-top:14px}
.loginWrap{max-width:430px;margin:12vh auto 0}
.loginCard{padding:24px}
.loginCard p{color:var(--muted);margin:0 0 16px}
.loginCard input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font:inherit;outline:none}
.loginCard input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.loginCard button{margin-top:12px;width:100%;padding:10px 12px;border:0;border-radius:9px;background:var(--blue);color:#fff;font:inherit;cursor:pointer}
.loginCard button:hover{background:#1d4ed8}
@media(max-width:900px){.mainGrid,.lowerGrid{grid-template-columns:1fr}.platform{min-height:150px}}
@media(max-width:640px){main{padding:20px 14px 36px}.kpis{grid-template-columns:repeat(2,1fr)}.meta{display:none}.brand h1{font-size:18px}.kpi b{font-size:22px}}
`;

const CHART_SCRIPT = `
(() => {
  const svg = document.getElementById("trendChart");
  const tip = document.getElementById("chartTooltip");
  const guide = document.getElementById("chartGuide");
  if (!svg || !tip || !guide) return;
  const points = Array.from(svg.querySelectorAll("[data-point]"));
  if (points.length === 0) return;
  const wrap = svg.parentElement;
  const fmt = (value) => Number(value).toLocaleString("zh-CN");
  const hide = () => { tip.hidden = true; guide.style.display = "none"; };
  const show = (point) => {
    const box = svg.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    const cx = Number(point.getAttribute("cx"));
    const cy = Number(point.getAttribute("cy"));
    const left = box.left - wrapBox.left + (cx / view.width) * box.width;
    const top = box.top - wrapBox.top + (cy / view.height) * box.height;
    const day = point.getAttribute("data-day") || "";
    const current = Number(point.getAttribute("data-value") || 0);
    const rawPrev = point.getAttribute("data-prev") || "";
    const hasPrev = rawPrev !== "";
    const previous = hasPrev ? Number(rawPrev) : 0;
    document.getElementById("ttDate").textContent = day;
    document.getElementById("ttCurrent").textContent = fmt(current);
    document.getElementById("ttPrevious").textContent = hasPrev ? fmt(previous) : "—";
    document.getElementById("ttPrevRow2").style.display = hasPrev ? "" : "none";
    const delta = document.getElementById("ttDelta");
    if (!hasPrev) {
      delta.textContent = "";
      delta.className = "ttDelta flat";
    } else if (previous === 0) {
      delta.textContent = current === 0 ? "0%" : "新增";
      delta.className = "ttDelta flat";
    } else {
      const change = ((current - previous) / previous) * 100;
      delta.textContent = (change >= 0 ? "+" : "") + change.toFixed(1) + "%";
      delta.className = "ttDelta " + (change > 0 ? "up" : change < 0 ? "down" : "flat");
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = Math.min(Math.max(8, left + 16), wrapBox.width - tw - 8) + "px";
    tip.style.top = Math.min(Math.max(8, top - th - 14), wrapBox.height - th - 8) + "px";
    guide.setAttribute("x1", String(cx));
    guide.setAttribute("x2", String(cx));
    guide.setAttribute("y1", "18");
    guide.setAttribute("y2", "230");
    guide.style.display = "block";
  };
  const move = (event) => {
    const box = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    const x = ((event.clientX - box.left) / box.width) * view.width;
    let best = points[0];
    let distance = Infinity;
    for (const point of points) {
      const next = Math.abs(Number(point.getAttribute("cx")) - x);
      if (next < distance) { distance = next; best = point; }
    }
    show(best);
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", hide);
})();
`;

const MARK = `<svg class="mark" viewBox="0 0 16 16" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true"><rect x=".5" y=".5" width="15" height="15"/><path d="M.5 3.5h12M12.5.5v12M3.5 12.5h12M3.5 3.5v12M6.5 3.5v9M9.5 3.5v9"/></svg>`;

const ICONS: Record<string, string> = {
  pulse: '<path d="M2 9h3l2-5 3 10 2-5h4"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 1.5v4M10.5 1.5v4"/>',
  users: '<circle cx="6" cy="6" r="2.5"/><path d="M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><path d="M11 4.5a2 2 0 0 1 0 3.8M12.5 13.5c0-1.8-.8-3-2-3.6"/>',
  box: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12M5 3v10M8 3v10M11 3v10"/>',
};

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

/** 合法的时间范围；未知值回落到最近 7 日。 */
export function parseRange(value: string | null): RangeKey {
  return value === "today" || value === "yesterday" || value === "30" ? value : "7";
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

/** 未登录 / 口令错误时的页面。 */
export function renderLogin(message = ""): string {
  const hint = message === "" ? "输入访问口令查看匿名使用统计。" : escapeHtml(message);
  return page("插件箱子 · 使用统计", `<div class="loginWrap"><header class="topbar"><div class="brand">${MARK}<div><h1>使用统计</h1><p class="sub">插件箱子 · anonymous usage count</p></div></div></header><section class="card loginCard"><p>${hint}</p><form method="get" action="/api/telemetry-stats"><input type="password" name="token" autofocus required placeholder="访问口令"><button type="submit">查看</button></form></section></div>`);
}

function dayLabel(day: string): string {
  return day.slice(5);
}

function percent(value: number, total: number): string {
  return total <= 0 ? "0%" : `${(value / total * 100).toFixed(1)}%`;
}

function niceStep(max: number): number {
  const rough = Math.max(1, max) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / power;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * power;
}

function kpiIcon(name: string): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] ?? ICONS.box}</svg>`;
}

function barRows(rows: ReadonlyArray<{ label: string; value: number }>, empty: string, showPercent: boolean): string {
  if (rows.length === 0) return `<p class="emptyState">${escapeHtml(empty)}</p>`;
  const max = Math.max(1, ...rows.map((row) => row.value));
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return `<div class="barList">${rows.map((row) => `<div class="barRow"><span class="barLabel" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><span class="barTrack"><i style="width:${(row.value / max * 100).toFixed(1)}%"></i></span><span class="barValue">${row.value}${showPercent ? `<small>${percent(row.value, total)}</small>` : ""}</span></div>`).join("")}</div>`;
}

/** 趋势图：当前周期与上一周期两条折线；单日区间退化为一个柱。 */
function trendChart(stats: Stats): string {
  const width = 720;
  const height = 260;
  const left = 42;
  const right = 14;
  const top = 18;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const current = stats.series;
  const previous = stats.previous;
  if (current.every((row) => row.installs === 0) && previous.every((row) => row.installs === 0)) {
    return `<p class="emptyState">这个区间还没有上报数据</p>`;
  }

  const max = Math.max(1, ...current.map((row) => row.installs), ...previous.map((row) => row.installs));
  const step = niceStep(max);
  const ceiling = step * 4;
  const xAt = (index: number, length: number): number => length <= 1 ? left + plotWidth / 2 : left + (index / (length - 1)) * plotWidth;
  const yAt = (value: number): number => top + plotHeight - (value / ceiling) * plotHeight;
  const baseline = top + plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = ceiling - index * step;
    const y = yAt(value);
    return `<line class="grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 8}" y="${y + 3}" text-anchor="end">${value}</text>`;
  }).join("");

  const xLabels = current.map((row, index) => {
    const stride = current.length <= 7 ? 1 : 5;
    if (index % stride !== 0 && index !== current.length - 1) return "";
    return `<text x="${xAt(index, current.length)}" y="${height - 8}" text-anchor="middle">${escapeHtml(dayLabel(row.day))}</text>`;
  }).join("");

  if (current.length === 1) {
    const row = current[0]!;
    const barWidth = 64;
    const barHeight = Math.max(4, (row.installs / ceiling) * plotHeight);
    return `<div class="chartWrap"><svg id="trendChart" class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="单日活跃安装">${grid}<rect x="${left + plotWidth / 2 - barWidth / 2}" y="${baseline - barHeight}" width="${barWidth}" height="${barHeight}" rx="6" fill="#2563eb" opacity=".9" aria-label="${escapeHtml(row.day)} · ${row.installs}"></rect><text x="${left + plotWidth / 2}" y="${baseline - barHeight - 8}" text-anchor="middle" fill="#2563eb" font-size="12">${row.installs}</text>${xLabels}</svg></div>`;
  }

  const points = (rows: DayRow[]): Array<{ x: number; y: number; row: DayRow }> =>
    rows.map((row, index) => ({ x: xAt(index, rows.length), y: yAt(row.installs), row }));
  const currentPoints = points(current);
  const previousPoints = points(previous);
  const line = (list: Array<{ x: number; y: number }>): string => list.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
  const currentLine = line(currentPoints);
  const area = `${currentLine} L ${currentPoints.at(-1)!.x} ${baseline} L ${currentPoints[0]!.x} ${baseline} Z`;
  const previousLine = previousPoints.length === 0 ? "" : `<path class="previous" d="${line(previousPoints)}"/>`;
  const dots = (list: Array<{ x: number; y: number; row: DayRow }>, kind: string, interactive: boolean): string =>
    list.map((point, index) => {
      const previousValue = stats.previous[index]?.installs;
      const data = interactive
        ? ` data-point="true" data-day="${escapeHtml(point.row.day)}" data-value="${point.row.installs}" data-prev="${previousValue === undefined ? "" : previousValue}"`
        : "";
      return `<circle class="${kind}" cx="${point.x}" cy="${point.y}" r="${kind === "point" ? 3.5 : 2.5}" aria-label="${escapeHtml(point.row.day)} · ${point.row.installs}"${data}></circle>`;
    }).join("");
  const tooltip = `<div class="chartTooltip" id="chartTooltip" hidden><div class="ttTop"><span class="ttDate" id="ttDate"></span><span class="ttDelta" id="ttDelta"></span></div><div class="ttRow"><i class="blue"></i><span>本周期</span><b id="ttCurrent"></b></div><div class="ttRow" id="ttPrevRow2"><i class="orange"></i><span>上一周期</span><b id="ttPrevious"></b></div></div>`;
  return `<div class="chartWrap"><svg id="trendChart" class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="活跃安装趋势"><defs><linearGradient id="areaBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity=".22"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>${grid}${xLabels}<path d="${area}" fill="url(#areaBlue)"/><line id="chartGuide" class="guide" x1="0" y1="18" x2="0" y2="230"/><path class="current" d="${currentLine}"/>${previousLine}${dots(previousPoints, "pointPrev", false)}${dots(currentPoints, "point", true)}</svg>${tooltip}</div>`;
}

function platformCard(stats: Stats): string {
  const web = stats.kinds.find((row) => row.kind === "web")?.installs ?? 0;
  const desktop = stats.kinds.find((row) => row.kind === "desktop")?.installs ?? 0;
  const total = web + desktop;
  const max = Math.max(1, web, desktop);
  const height = (value: number): number => value === 0 ? 4 : Math.max(6, Math.round(value / max * 126));
  const body = total === 0
    ? `<p class="emptyState">还没有数据</p>`
    : `<div class="platform"><div class="vbarItem"><b>${web}</b><div class="vbarTrack"><i class="blueBar" style="height:${height(web)}px"></i></div><span>网页端</span></div><div class="vbarItem"><b>${desktop}</b><div class="vbarTrack"><i class="orangeBar" style="height:${height(desktop)}px"></i></div><span>桌面端</span></div></div><div class="miniGrid"><div class="mini blue"><span>网页端占比</span><b>${percent(web, total)}</b></div><div class="mini orange"><span>桌面端占比</span><b>${percent(desktop, total)}</b></div></div>`;
  return `<section class="card"><div class="cardHead"><div><h2>平台分布</h2><p>${escapeHtml(stats.rangeLabel)} · 按安装去重</p></div></div>${body}</section>`;
}

function rangeTabs(active: RangeKey): string {
  const keys: RangeKey[] = ["today", "yesterday", "7", "30"];
  return `<nav class="tabs">${keys.map((key) => `<a class="tab${key === active ? " on" : ""}" href="?range=${key}">${RANGES[key].label}</a>`).join("")}</nav>`;
}

/** 看板主体。 */
export function renderStats(stats: Stats, nonce = ""): string {
  const cards = [
    ["pulse", "今日活跃", stats.today, "日活"],
    ["calendar", "近 7 天", stats.week, "周活"],
    ["users", "近 30 天", stats.month, "月活"],
    ["box", "累计安装", stats.total, "全部"],
  ].map(([icon, label, value, sub]) => `<div class="kpi"><span class="kpiIcon">${kpiIcon(String(icon))}</span><div><span class="kpiLabel">${String(label)}</span><b>${Number(value)}</b><small>${String(sub)}</small></div></div>`).join("");
  const versions = barRows(stats.versions.map((row) => ({ label: `v${row.v}`, value: row.installs })), "还没有数据", true);
  const regions = barRows(stats.regions.map((row) => ({ label: row.region === "global" ? "全球" : row.region === "china" ? "中国" : row.region, value: row.installs })), "还没有数据", true);
  const hasPrevious = stats.previous.some((row) => row.installs > 0);
  const body = `<header class="topbar"><div class="brand">${MARK}<div><h1>使用统计</h1><p class="sub">插件箱子 · 匿名使用统计</p></div></div><div class="meta"><span>更新于 ${escapeHtml(stats.updatedAt)} UTC</span><a href="?logout=1">退出查看</a></div></header>${rangeTabs(stats.range)}<div class="kpis">${cards}</div><div class="mainGrid"><section class="card"><div class="cardHead"><div><h2>趋势分析</h2><p>${escapeHtml(stats.rangeLabel)} · 区间活跃 ${stats.rangeActive}</p></div><div class="legend"><span><i class="blue"></i>本周期</span>${hasPrevious ? '<span><i class="orange"></i>上一周期</span>' : ""}</div></div>${trendChart(stats)}</section>${platformCard(stats)}</div><div class="lowerGrid"><section class="card"><div class="cardHead"><div><h2>版本分布</h2><p>${escapeHtml(stats.rangeLabel)} · 同一安装跨版本可能重复计入</p></div></div>${versions}</section><section class="card"><div class="cardHead"><div><h2>区域分布</h2><p>${escapeHtml(stats.rangeLabel)} · 按安装去重</p></div></div>${regions}</section></div><p class="note">只统计主动开启匿名统计的安装；插件默认开启，可随时关闭。每个安装每个 UTC 日最多计一次。</p>`;
  const script = nonce === "" ? "" : `<script nonce="${escapeHtml(nonce)}">${CHART_SCRIPT}</script>`;
  return page("插件箱子 · 使用统计", body + script);
}

function offsets(length: number, endOffset: number): string[] {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + endOffset);
  return Array.from({ length }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (length - 1 - index));
    return date.toISOString().slice(0, 10);
  });
}

function fillSeries(rows: DayRow[], length: number, endOffset: number): DayRow[] {
  const byDay = new Map(rows.map((row) => [row.day, Number(row.installs) || 0]));
  return offsets(length, endOffset).map((day) => ({ day, installs: byDay.get(day) ?? 0 }));
}

/** 读取所有看板数据；任何一条查询失败都会抛给调用方。 */
export async function loadStats(db: D1Like, range: RangeKey): Promise<Stats> {
  const config = RANGES[range];
  const previousQuery = config.previous
    ? db.prepare(`SELECT day, COUNT(*) AS installs FROM pings WHERE ${config.previous.filter} GROUP BY day ORDER BY day`).all<DayRow>()
    : Promise.resolve({ results: [] as DayRow[] });
  const [daily, previous, active, today, week, month, total, versions, kinds, regions] = await Promise.all([
    db.prepare(`SELECT day, COUNT(*) AS installs FROM pings WHERE ${config.filter} GROUP BY day ORDER BY day`).all<DayRow>(),
    previousQuery,
    db.prepare(`SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE ${config.filter}`).all<CountRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE day = date('now')").all<CountRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE day >= date('now','-6 days')").all<CountRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE day >= date('now','-29 days')").all<CountRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings").all<CountRow>(),
    db.prepare(`SELECT v, COUNT(DISTINCT id) AS installs FROM pings WHERE ${config.filter} GROUP BY v ORDER BY installs DESC`).all<VersionRow>(),
    db.prepare(`SELECT kind, COUNT(DISTINCT id) AS installs FROM pings WHERE ${config.filter} GROUP BY kind ORDER BY installs DESC`).all<KindRow>(),
    db.prepare(`SELECT region, COUNT(DISTINCT id) AS installs FROM pings WHERE ${config.filter} GROUP BY region ORDER BY installs DESC`).all<RegionRow>(),
  ]);
  const series = fillSeries(daily.results ?? [], config.length, 0);
  const previousSeries = config.previous ? fillSeries(previous.results ?? [], config.length, -config.length) : [];
  return {
    range,
    rangeLabel: config.label,
    today: Number(today.results?.[0]?.installs ?? 0),
    week: Number(week.results?.[0]?.installs ?? 0),
    month: Number(month.results?.[0]?.installs ?? 0),
    total: Number(total.results?.[0]?.installs ?? 0),
    rangeActive: Number(active.results?.[0]?.installs ?? 0),
    series,
    previous: previousSeries,
    versions: versions.results ?? [],
    kinds: kinds.results ?? [],
    regions: regions.results ?? [],
    updatedAt: new Date().toISOString().replace("T", " ").slice(0, 16),
  };
}

function htmlResponse(html: string, status = 200, extra: Record<string, string> = {}, nonce?: string): Response {
  const script = nonce === undefined ? "" : ` script-src 'nonce-${nonce}'`;
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline';${script} form-action 'self'; base-uri 'none'`,
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
    const nonce = crypto.randomUUID().replace(/-/gu, "");
    const stats = await loadStats(env.DB, parseRange(url.searchParams.get("range")));
    const headers: Record<string, string> = {};
    if (url.searchParams.has("token")) {
      headers["set-cookie"] = `${COOKIE}=${encodeURIComponent(expected)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
    }
    return htmlResponse(renderStats(stats, nonce), 200, headers, nonce);
  } catch {
    return htmlResponse(renderLogin("读取统计失败，请稍后再试。"), 503);
  }
}
