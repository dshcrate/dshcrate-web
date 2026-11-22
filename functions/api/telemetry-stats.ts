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
interface DayRow { day: string; installs: number; opened: number }
interface VersionRow { v: string; installs: number }
interface KindRow { kind: string; installs: number }
interface RegionRow { region: string; installs: number }

/** 月度趋势的一个点；未来日期和上月不存在的日期为 null。 */
export interface MonthPoint {
  day: number;
  installs: number | null;
  opened: number | null;
}

export interface Stats {
  monthLabel: string;
  /** 本月去重安装数 */
  monthActive: number;
  /** 本月打开过市场的去重安装数 */
  monthOpened: number;
  /** 上月整月去重安装数，仅用于对比 */
  lastMonthActive: number;
  /** 本月每日活跃的平均值 */
  avgDaily: number;
  /** 全部时间累计安装 */
  total: number;
  /** 今天是本月的第几天 */
  today: number;
  series: MonthPoint[];
  previous: MonthPoint[];
  versions: VersionRow[];
  kinds: KindRow[];
  regions: RegionRow[];
  updatedAt: string;
}

const COOKIE = "dsh_telemetry_stats";
const CSS = `
:root{color-scheme:light;--ink:#172033;--muted:#6b7280;--faint:#98a2b3;--line:#e7ecf2;--bg:#f5f7fa;--card:#fff;--blue:#2563eb;--orange:#f59e0b;--green:#12b76a;--slate:#64748b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 20px 48px}
.topbar{display:flex;align-items:center;gap:14px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px;flex:1}
h1{font-size:20px;line-height:1.2;margin:0;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:12px;margin:3px 0 0}
.meta{display:flex;align-items:center;gap:14px;color:var(--faint);font-size:12px;white-space:nowrap}
.meta a{color:var(--muted);text-decoration:none}
.meta a:hover{color:var(--blue)}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:15px 16px;display:flex;gap:12px;align-items:center;box-shadow:0 1px 2px rgba(16,24,40,.03);min-width:0}
.kpiIcon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:none}
.kpiIcon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.kpi:nth-child(1) .kpiIcon{background:#eaf1ff;color:var(--blue)}
.kpi:nth-child(2) .kpiIcon{background:#fff5e6;color:var(--orange)}
.kpi:nth-child(3) .kpiIcon{background:#e8f8f1;color:var(--green)}
.kpi:nth-child(4) .kpiIcon{background:#eef2f6;color:var(--slate)}
.kpi:nth-child(5) .kpiIcon{background:#f3e8ff;color:#7c3aed}
.kpiBody{min-width:0;flex:1}
.kpiLabel{display:block;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpiValue{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.kpi b{font-size:25px;line-height:1.15;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi small{color:var(--faint);font-size:11px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpiDelta{font-size:11px;font-weight:600;padding:1px 6px;border-radius:999px;background:#f1f5f9;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.kpiDelta.up{background:#e8f8f1;color:#0b8a52}
.kpiDelta.down{background:#fef3f2;color:#d92d20}
.kpiDelta.flat{background:#f1f5f9;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 2px rgba(16,24,40,.03);padding:16px 18px}
.trendCard{margin-bottom:14px}
.breakdownGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.cardHead{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.cardHead h2{font-size:14px;margin:0;line-height:1.4}
.cardHead p{color:var(--muted);font-size:12px;margin:2px 0 0}
.legend{margin-left:auto;display:flex;align-items:center;gap:14px;color:var(--muted);font-size:12px;white-space:nowrap}
.legend i{display:inline-block;width:8px;height:8px;border-radius:999px;margin-right:5px}
.legend .blue{background:var(--blue)}
.legend .slate{background:var(--slate)}
.chart{width:100%;height:auto;display:block}
.chart text{font-size:10px;fill:var(--faint)}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .axis{fill:var(--faint)}
.chart .current{fill:none;stroke:var(--blue);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.chart .previous{fill:none;stroke:var(--slate);stroke-width:1.6;stroke-dasharray:5 5;stroke-linecap:round;stroke-linejoin:round}
.chart .point{fill:#fff;stroke:var(--blue);stroke-width:2;pointer-events:none}
.chart .todayLine{stroke:#94a3b8;stroke-width:1;stroke-dasharray:4 4}
.chart .todayLabel{fill:#475569;font-size:10px;font-weight:600}
.chart .todayPoint{fill:var(--blue);stroke:#fff;stroke-width:2.5}
.chartWrap{position:relative}
.chart .guide{stroke:#cbd5e1;stroke-width:1;stroke-dasharray:4 4;display:none}
.chartTooltip{position:absolute;z-index:5;min-width:210px;padding:12px 14px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 28px rgba(16,24,40,.14);pointer-events:none;font-size:12px;line-height:1.5}
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
.ttRow i.slate{background:var(--slate)}
.ttRow b{margin-left:auto;color:var(--ink);font-variant-numeric:tabular-nums}
.stackBar{display:flex;height:12px;border-radius:999px;overflow:hidden;background:#eef2f7;margin:16px 0 18px}
.stackBar i{display:block;height:100%}
.segBlue{background:linear-gradient(90deg,#60a5fa,#2563eb)}
.segOrange{background:linear-gradient(90deg,#fbbf24,#f59e0b)}
.stackLegend{display:grid;gap:12px}
.stackRow{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.stackRow b{margin-left:auto;color:var(--ink);font-variant-numeric:tabular-nums}
.stackRow small{color:var(--faint);width:48px;text-align:right;font-variant-numeric:tabular-nums}
.dot{width:8px;height:8px;border-radius:999px;flex:none}
.dot.blue{background:var(--blue)}
.dot.orange{background:var(--orange)}
.barList{display:flex;flex-direction:column;gap:9px}
.barRow{display:grid;grid-template-columns:minmax(68px,1fr) minmax(70px,2.2fr) minmax(82px,auto);gap:10px;align-items:center;font-size:12px}
.barLabel{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.barTrack{height:8px;background:#eef2f7;border-radius:999px;overflow:hidden}
.barTrack i{display:block;height:100%;border-radius:999px;background:var(--blue)}
.barValue{text-align:right;color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.barValue small{color:var(--faint);margin-left:3px}
.emptyState{color:var(--muted);font-size:12px;padding:24px 0;text-align:center}
.note{color:var(--faint);font-size:12px;margin-top:14px}
.loginWrap{max-width:430px;margin:12vh auto 0}
.loginCard{padding:24px}
.loginCard p{color:var(--muted);margin:0 0 16px}
.loginCard input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font:inherit;outline:none}
.loginCard input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.loginCard button{margin-top:12px;width:100%;padding:10px 12px;border:0;border-radius:9px;background:var(--blue);color:#fff;font:inherit;cursor:pointer}
.loginCard button:hover{background:#1d4ed8}
@media(max-width:900px){.breakdownGrid{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:640px){main{padding:20px 14px 36px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.meta{display:none}.brand h1{font-size:18px}.kpi b{font-size:22px}}
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
    const opened = Number(point.getAttribute("data-opened") || 0);
    const rawPrev = point.getAttribute("data-prev") || "";
    const hasPrev = rawPrev !== "";
    const previous = hasPrev ? Number(rawPrev) : 0;
    document.getElementById("ttDate").textContent = day;
    document.getElementById("ttCurrent").textContent = fmt(current);
    document.getElementById("ttOpened").textContent = fmt(opened);
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
    guide.setAttribute("y2", String(view.height - 32));
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

const ICONS: Record<string, string> = {
  pulse: '<path d="M2 9h3l2-5 3 10 2-5h4"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M5.5 1.5v4M10.5 1.5v4"/>',
  users: '<circle cx="6" cy="6" r="2.5"/><path d="M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/><path d="M11 4.5a2 2 0 0 1 0 3.8M12.5 13.5c0-1.8-.8-3-2-3.6"/>',
  box: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12M5 3v10M8 3v10M11 3v10"/>',
  eye: '<path d="M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4-6.5-4-6.5-4Z"/><circle cx="8" cy="8" r="2"/>',
  percent: '<circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="12" r="1.5"/><path d="M13 3 3 13"/>',
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

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

/** 未登录 / 口令错误时的页面。 */
export function renderLogin(message = ""): string {
  const hint = message === "" ? "输入访问口令查看匿名使用统计。" : escapeHtml(message);
  return page("插件箱子 · 使用统计", `<div class="loginWrap"><header class="topbar"><div class="brand"><div><h1>使用统计</h1><p class="sub">插件箱子 · anonymous usage count</p></div></div></header><section class="card loginCard"><p>${hint}</p><form method="get" action="/api/telemetry-stats"><input type="password" name="token" autofocus required placeholder="访问口令"><button type="submit">查看</button></form></section></div>`);
}

function percent(value: number, total: number): string {
  return total <= 0 ? "0%" : `${(value / total * 100).toFixed(1)}%`;
}

function displayNumber(value: number): string {
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

function niceStep(max: number): number {
  const rough = Math.max(1, max) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / power;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(1, step * power);
}

function kpiIcon(name: string): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] ?? ICONS.box}</svg>`;
}

function emptyState(text: string): string {
  return `<p class="emptyState">${escapeHtml(text)}</p>`;
}

/** 与上月相比的变化；上月为 0 时不显示百分比。 */
function deltaChip(current: number, previous: number, label: string): string {
  if (previous <= 0) return `<span class="kpiDelta flat" title="${escapeHtml(label)}">—</span>`;
  const change = ((current - previous) / previous) * 100;
  const kind = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return `<span class="kpiDelta ${kind}" title="${escapeHtml(label)}">${change >= 0 ? "+" : ""}${change.toFixed(1)}%</span>`;
}

/** 横向占比条：宽度按总量归一化。 */
function shareRows(rows: ReadonlyArray<{ label: string; value: number }>, empty: string): string {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (rows.length === 0 || total === 0) return emptyState(empty);
  return `<div class="barList">${rows.map((row) => `<div class="barRow"><span class="barLabel" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><span class="barTrack"><i style="width:${(row.value / total * 100).toFixed(1)}%"></i></span><span class="barValue">${displayNumber(row.value)}<small>${percent(row.value, total)}</small></span></div>`).join("")}</div>`;
}

/** 取前 N 名，其余合并为「其他」。 */
function topRows<T>(rows: T[], label: (row: T) => string, value: (row: T) => number, limit = 5): Array<{ label: string; value: number }> {
  const sorted = [...rows].sort((left, right) => value(right) - value(left));
  const top = sorted.slice(0, limit).map((row) => ({ label: label(row), value: value(row) }));
  const rest = sorted.slice(limit).reduce((sum, row) => sum + value(row), 0);
  if (rest > 0) top.push({ label: "其他", value: rest });
  return top;
}

/** 本月 / 上月月度趋势；今天单独高亮。 */
function trendChart(stats: Stats): string {
  const width = 720;
  const height = 300;
  const left = 42;
  const right = 16;
  const top = 24;
  const bottom = 32;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const baseline = top + plotHeight;
  const days = stats.series.length;
  const values = [...stats.series, ...stats.previous]
    .map((point) => point.installs)
    .filter((value): value is number => value !== null);
  if (values.every((value) => value === 0)) return emptyState("本月还没有上报数据");

  const max = Math.max(1, ...values);
  const step = niceStep(max);
  const ceiling = step * 4;
  const xAt = (day: number): number => left + ((day - 1) / Math.max(1, days - 1)) * plotWidth;
  const yAt = (value: number): number => top + plotHeight - (value / ceiling) * plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = ceiling - index * step;
    const y = yAt(value);
    return `<line class="grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="axis" x="${left - 8}" y="${y + 3}" text-anchor="end">${value}</text>`;
  }).join("");
  const labelDays = [1, 5, 10, 15, 20, 25, 30].filter((day) => day <= days);
  if (labelDays.at(-1) !== days) labelDays.push(days);
  const xLabels = labelDays.map((day) => `<text x="${xAt(day)}" y="${height - 8}" text-anchor="middle">${day}</text>`).join("");
  const pathFor = (points: MonthPoint[]): string => {
    let path = "";
    let pen = false;
    for (const point of points) {
      if (point.installs === null) { pen = false; continue; }
      path += `${pen ? "L" : "M"}${xAt(point.day).toFixed(1)} ${yAt(point.installs).toFixed(1)} `;
      pen = true;
    }
    return path.trim();
  };
  const currentPath = pathFor(stats.series);
  const previousPath = pathFor(stats.previous);
  const currentPoints = stats.series.filter((point) => point.installs !== null);
  const first = currentPoints[0];
  const last = currentPoints.at(-1);
  const area = first === undefined || last === undefined ? "" : `${currentPath} L ${xAt(last.day).toFixed(1)} ${baseline} L ${xAt(first.day).toFixed(1)} ${baseline} Z`;
  const previousByDay = new Map(stats.previous.map((point) => [point.day, point.installs]));
  const dots = currentPoints.map((point) => {
    const previous = previousByDay.get(point.day);
    return `<circle class="point" cx="${xAt(point.day).toFixed(1)}" cy="${yAt(point.installs ?? 0).toFixed(1)}" r="3" aria-label="${point.day} 日 · ${point.installs}" data-point="true" data-day="${escapeHtml(stats.monthLabel)} ${point.day} 日" data-value="${point.installs ?? 0}" data-opened="${point.opened ?? 0}" data-prev="${previous === null || previous === undefined ? "" : previous}"></circle>`;
  }).join("");
  const todayValue = stats.series.find((point) => point.day === stats.today)?.installs ?? 0;
  const todayX = xAt(stats.today);
  const todayMarker = `<line class="todayLine" x1="${todayX.toFixed(1)}" y1="${top}" x2="${todayX.toFixed(1)}" y2="${baseline}"></line><text class="todayLabel" x="${todayX.toFixed(1)}" y="${top - 8}" text-anchor="middle">今天</text><circle class="todayPoint" cx="${todayX.toFixed(1)}" cy="${yAt(todayValue).toFixed(1)}" r="4"></circle>`;
  const tooltip = `<div class="chartTooltip" id="chartTooltip" hidden><div class="ttTop"><span class="ttDate" id="ttDate"></span><span class="ttDelta" id="ttDelta"></span></div><div class="ttRow"><i class="blue"></i><span>本月活跃</span><b id="ttCurrent"></b></div><div class="ttRow"><i class="orange"></i><span>本月打开</span><b id="ttOpened"></b></div><div class="ttRow" id="ttPrevRow2"><i class="slate"></i><span>上月同日</span><b id="ttPrevious"></b></div></div>`;
  return `<div class="chartWrap"><svg id="trendChart" class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="本月与上月每日活跃"><defs><linearGradient id="areaBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity=".22"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs>${grid}${xLabels}<path d="${area}" fill="url(#areaBlue)"/><line id="chartGuide" class="guide" x1="0" y1="18" x2="0" y2="${height - 32}"></line><path class="current" d="${currentPath}"/><path class="previous" d="${previousPath}"/>${todayMarker}${dots}</svg>${tooltip}</div>`;
}

/** 趋势卡：固定显示本月与上月，不随区间变化。 */
function trendCard(stats: Stats): string {
  return `<section class="card trendCard"><div class="cardHead"><div><h2>趋势分析</h2><p>本月每日活跃 · 今天突出显示</p></div><div class="legend"><span><i class="blue"></i>本月</span><span><i class="slate"></i>上月</span></div></div>${trendChart(stats)}</section>`;
}

/** 平台分布：横向占比条。 */
function platformCard(stats: Stats): string {
  const web = stats.kinds.find((row) => row.kind === "web")?.installs ?? 0;
  const desktop = stats.kinds.find((row) => row.kind === "desktop")?.installs ?? 0;
  const total = web + desktop;
  const body = total === 0
    ? emptyState("还没有数据")
    : `<div class="stackBar">${web > 0 ? `<i class="segBlue" style="width:${(web / total * 100).toFixed(1)}%"></i>` : ""}${desktop > 0 ? `<i class="segOrange" style="width:${(desktop / total * 100).toFixed(1)}%"></i>` : ""}</div><div class="stackLegend"><div class="stackRow"><i class="dot blue"></i><span>网页端</span><b>${displayNumber(web)}</b><small>${percent(web, total)}</small></div><div class="stackRow"><i class="dot orange"></i><span>桌面端</span><b>${displayNumber(desktop)}</b><small>${percent(desktop, total)}</small></div></div>`;
  return `<section class="card"><div class="cardHead"><div><h2>平台分布</h2><p>本月 · 按安装去重</p></div></div>${body}</section>`;
}

function versionCard(stats: Stats): string {
  const rows = topRows(stats.versions, (row) => `v${row.v}`, (row) => row.installs);
  return `<section class="card"><div class="cardHead"><div><h2>版本分布</h2><p>本月 · 同一安装跨版本可能重复计入</p></div></div>${shareRows(rows, "还没有数据")}</section>`;
}

function regionCard(stats: Stats): string {
  const rows = topRows(stats.regions, (row) => row.region === "global" ? "全球" : row.region === "china" ? "中国" : row.region, (row) => row.installs);
  return `<section class="card"><div class="cardHead"><div><h2>区域分布</h2><p>本月 · 按安装去重</p></div></div>${shareRows(rows, "还没有数据")}</section>`;
}

function kpiCards(stats: Stats): string {
  const items = [
    { icon: "pulse", label: "本月活跃", value: displayNumber(stats.monthActive), sub: "去重安装", delta: deltaChip(stats.monthActive, stats.lastMonthActive, "较上月") },
    { icon: "eye", label: "本月打开", value: displayNumber(stats.monthOpened), sub: "去重安装", delta: "" },
    { icon: "percent", label: "打开率", value: percent(stats.monthOpened, stats.monthActive), sub: "打开 ÷ 活跃", delta: "" },
    { icon: "users", label: "日均活跃", value: displayNumber(stats.avgDaily), sub: `按 ${stats.today} 天平均`, delta: "" },
    { icon: "box", label: "累计安装", value: displayNumber(stats.total), sub: "全部时间", delta: "" },
  ];
  return items.map((item) => `<div class="kpi"><span class="kpiIcon">${kpiIcon(item.icon)}</span><div class="kpiBody"><span class="kpiLabel">${item.label}</span><div class="kpiValue"><b>${item.value}</b>${item.delta}</div><small>${item.sub}</small></div></div>`).join("");
}

/** 看板主体。 */
export function renderStats(stats: Stats, nonce = ""): string {
  const body = `<header class="topbar"><div class="brand"><div><h1>使用统计</h1><p class="sub">插件箱子 · 匿名使用统计 · ${escapeHtml(stats.monthLabel)}</p></div></div><div class="meta"><span>更新于 ${escapeHtml(stats.updatedAt)} UTC</span><a href="?logout=1">退出查看</a></div></header><div class="kpis">${kpiCards(stats)}</div>${trendCard(stats)}<div class="breakdownGrid">${platformCard(stats)}${versionCard(stats)}${regionCard(stats)}</div><p class="note">只统计主动开启匿名统计的安装；插件默认开启，可随时关闭。每个安装每个 UTC 日最多计一次，另有一次“当天打开过页面”的标记。</p>`;
  const script = nonce === "" ? "" : `<script nonce="${escapeHtml(nonce)}">${CHART_SCRIPT}</script>`;
  return page("插件箱子 · 使用统计", body + script);
}

/** 生成本月 1 日到月末的点；未来日期为 null。 */
function monthSeries(rows: DayRow[], days: number, through: number): MonthPoint[] {
  const byDay = new Map(rows.map((row) => [Number(row.day.slice(8, 10)), { installs: Number(row.installs) || 0, opened: Number(row.opened) || 0 }]));
  return Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const row = byDay.get(day);
    return day <= through
      ? { day, installs: row?.installs ?? 0, opened: row?.opened ?? 0 }
      : { day, installs: null, opened: null };
  });
}

/** 读取本月看板数据；任何一条查询失败都会抛给调用方。 */
export async function loadStats(db: D1Like): Promise<Stats> {
  const monthFilter = "day >= date('now','start of month') AND day <= date('now')";
  const lastMonthFilter = "day >= date('now','start of month','-1 month') AND day < date('now','start of month')";
  const [current, previous, active, opened, lastActive, total, versions, kinds, regions] = await Promise.all([
    db.prepare(`SELECT day, COUNT(*) AS installs, SUM(opened) AS opened FROM pings WHERE ${monthFilter} GROUP BY day ORDER BY day`).all<DayRow>(),
    db.prepare(`SELECT day, COUNT(*) AS installs, SUM(opened) AS opened FROM pings WHERE ${lastMonthFilter} GROUP BY day ORDER BY day`).all<DayRow>(),
    db.prepare(`SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE ${monthFilter}`).all<CountRow>(),
    db.prepare(`SELECT COUNT(DISTINCT CASE WHEN opened = 1 THEN id END) AS installs FROM pings WHERE ${monthFilter}`).all<CountRow>(),
    db.prepare(`SELECT COUNT(DISTINCT id) AS installs FROM pings WHERE ${lastMonthFilter}`).all<CountRow>(),
    db.prepare("SELECT COUNT(DISTINCT id) AS installs FROM pings").all<CountRow>(),
    db.prepare(`SELECT v, COUNT(DISTINCT id) AS installs FROM pings WHERE ${monthFilter} GROUP BY v ORDER BY installs DESC`).all<VersionRow>(),
    db.prepare(`SELECT kind, COUNT(DISTINCT id) AS installs FROM pings WHERE ${monthFilter} GROUP BY kind ORDER BY installs DESC`).all<KindRow>(),
    db.prepare(`SELECT region, COUNT(DISTINCT id) AS installs FROM pings WHERE ${monthFilter} GROUP BY region ORDER BY installs DESC`).all<RegionRow>(),
  ]);
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysInLastMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const series = monthSeries(current.results ?? [], daysInMonth, today);
  const previousSeries = monthSeries(previous.results ?? [], daysInMonth, daysInLastMonth);
  const sum = series.reduce((acc, point) => acc + (point.installs ?? 0), 0);
  return {
    monthLabel: `${year} 年 ${month + 1} 月`,
    monthActive: Number(active.results?.[0]?.installs ?? 0),
    monthOpened: Number(opened.results?.[0]?.installs ?? 0),
    lastMonthActive: Number(lastActive.results?.[0]?.installs ?? 0),
    avgDaily: today > 0 ? sum / today : 0,
    total: Number(total.results?.[0]?.installs ?? 0),
    today,
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
    const stats = await loadStats(env.DB);
    const headers: Record<string, string> = {};
    if (url.searchParams.has("token")) {
      headers["set-cookie"] = `${COOKIE}=${encodeURIComponent(expected)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
    }
    return htmlResponse(renderStats(stats, nonce), 200, headers, nonce);
  } catch {
    return htmlResponse(renderLogin("读取统计失败，请稍后再试。"), 503);
  }
}
