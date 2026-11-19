/**
 * 全站中间件：让不存在的路径返回真实的 404 状态码。
 *
 * 站点是单页应用，`_redirects` 里的 `/* /index.html 200` 把所有路径都按 200 交付，
 * 于是 `/about` 这类不存在的地址会变成 soft 404（状态码 200、内容是首页），
 * 搜索引擎会把它们当成有效页面收录。这里在链路最前面做一次判定：
 *
 * 只拦「不带扩展名、也不在站内路由白名单里」的请求，其余一律放行，
 * 所以静态资源、数据切片、收录接口都不会被误伤，详情页直达行为也不变。
 *
 * 拦截时不另外维护一份 404 页面：直接把单页应用的入口以 404 状态码返回，
 * 前端路由会渲染 NotFoundPage，文案与样式只保留一份。
 */

/** 站内真实路由：只有这些无扩展名路径才交给单页应用处理。 */
const APP_ROUTES = [/^\/$/, /^\/top\/?$/, /^\/favorites\/?$/, /^\/submit\/?$/, /^\/p\/[^/]+\/[^/]+\/?$/];

/** sitemap 路径：索引、静态页分片、详情页分片。 */
const SITEMAP_PATH = /^\/sitemap(?:-pages|-\d+)?\.xml$/;

/** 已删除的验证文件：直接返回 410，避免边缘缓存或 SPA 兜底继续把它们当成有效页面。 */
const GONE_PATHS = new Set([
  "/sogousiteverification.txt",
  "/baidu_verify_codeva-iFJaJ0PAjx.html",
]);

/** 详情页路径：/p/owner/repo（允许一个结尾斜杠）。 */
const DETAIL_PATH = /^\/p\/([^/]+)\/([^/]+)\/?$/;

/** 站点品牌与域名：详情页的静态 meta 不依赖客户端 JS 也要成立。 */
const SITE_ORIGIN = "https://dshcrate.com";
const SITE_NAME = "DSH 插件箱子";

/**
 * 把 URL 段里的特殊字符转成 HTML 实体。
 * 入参：value 为任意文本
 * 返回：可直接拼进标签属性的安全文本
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

/** 详情页不执行 JS 时也能读到的 meta。 */
export interface DetailMeta {
  title: string;
  description: string;
  canonical: string;
}

/**
 * 详情页的静态 meta：标题与描述由 URL 生成，保证每页唯一。
 *
 * 入参：pathname —— 形如 /p/owner/repo 的路径
 * 返回：命中详情页返回 meta；其他路径返回 null
 */
export function detailMeta(pathname: string): DetailMeta | null {
  const match = DETAIL_PATH.exec(pathname);
  if (match === null) return null;
  let owner = match[1]!;
  let repo = match[2]!;
  try {
    owner = decodeURIComponent(owner);
    repo = decodeURIComponent(repo);
  } catch {
    // 非法的百分号编码保留原样：宁可显示编码后的路径，也不要让请求 500
  }
  return {
    title: `${repo} · ${SITE_NAME} — DeepSeek Harness 插件`,
    description: `${owner}/${repo} 的插件详情：功能简介、安装命令、README、版本更新与相似插件推荐，尽在 ${SITE_NAME}。`,
    canonical: `${SITE_ORIGIN}/p/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  };
}

/**
 * 把详情页 meta 写进入口 HTML 的 head。
 *
 * 只替换固定标签，正文与脚本原样保留；不执行 JS 的爬虫也能读到本页唯一的
 * 标题、描述与 canonical，客户端渲染后仍会覆盖成真实简介。
 *
 * 入参：html —— 入口页 HTML；meta —— detailMeta 的结果
 * 返回：改写后的 HTML
 */
export function injectDetailMeta(html: string, meta: DetailMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const canonical = escapeHtml(meta.canonical);
  const apply = (current: string, pattern: RegExp, replacement: string): string =>
    pattern.test(current) ? current.replace(pattern, replacement) : current;
  let next = apply(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`);
  next = apply(next, /<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${description}" />`);
  next = apply(next, /<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${title}" />`);
  next = apply(next, /<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${description}" />`);
  next = apply(next, /<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${canonical}" />`);
  next = apply(next, /<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${title}" />`);
  next = apply(next, /<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${description}" />`);
  // canonical 原本由各页 useSeo 在渲染后写入；爬虫不执行 JS，所以详情页补一份静态的
  if (!next.includes('rel="canonical"')) {
    next = next.replace(
      /(<meta name="description" content="[^"]*"\s*\/?>)/,
      `$1\n    <link rel="canonical" href="${canonical}" />`,
    );
  }
  return next;
}

/**
 * 判断是否已删除的验证文件。
 * 入参：pathname 为请求路径（不含域名与查询串）
 * 返回：命中返回 true
 */
export function isGonePath(pathname: string): boolean {
  return GONE_PATHS.has(pathname);
}

/**
 * 判断是否 sitemap 请求。
 * 这些文件由构建期生成，缺失时必须是真 404；否则会被 SPA 兜底改写成 200 HTML，
 * Google 会当成解析失败（无法抓取）。
 *
 * 入参：pathname 为请求路径（不含域名与查询串）
 * 返回：命中 sitemap 路径返回 true
 */
export function isSitemapPath(pathname: string): boolean {
  return SITEMAP_PATH.test(pathname);
}

/** 这些前缀一律放行：构建产物、数据切片、收录接口。 */
const OPEN_PREFIXES = ["/assets/", "/data/", "/api/"];

/** 只声明用到的方法，避免为 Functions 引入整套 workers-types 与 DOM 类型打架。 */
interface AssetFetcher {
  fetch(input: URL): Promise<Response>;
}

interface Ctx {
  request: Request;
  env: { ASSETS: AssetFetcher };
  next: () => Promise<Response>;
}

export async function onRequest(context: Ctx): Promise<Response> {
  const { request, env, next } = context;
  // 只管读请求，写方法交给后面的处理逻辑
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const { pathname } = new URL(request.url);
  // 已删除的验证文件：410 直接返回，不读静态资源，也不会命中旧缓存
  if (isGonePath(pathname)) {
    return new Response("Gone", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  // sitemap 必须先确认文件真实存在：缺失时返回 404，不能被 SPA 兜底成 200 HTML
  if (isSitemapPath(pathname)) {
    const asset = await env.ASSETS.fetch(new URL(pathname, request.url));
    const contentType = asset.headers.get("content-type") ?? "";
    // 静态资源存在且是 XML 才放行；命中 SPA 兜底（text/html）同样按缺失处理
    if (asset.status === 200 && contentType.includes("xml")) return next();
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  // 带扩展名的（js/css/json/svg/png/txt/xml）与入口页本身一律放行
  if (pathname === "/index.html" || /\.[a-z0-9]+$/i.test(pathname)) return next();
  if (OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();

  // 详情页：不执行 JS 的爬虫（必应等）也要读到本页唯一的 title / description
  const meta = detailMeta(pathname);
  if (meta !== null) {
    const asset = await env.ASSETS.fetch(new URL("/index.html", request.url));
    if (asset.status === 200) {
      const html = await asset.text();
      const headers = new Headers(asset.headers);
      // 改写后的长度、编码与 ETag 与原文不再对应，避免客户端按旧头解码
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("etag");
      headers.set("content-type", "text/html; charset=utf-8");
      // 同一路径的 meta 固定；部署后最多一小时旧版本，页面内容由客户端渲染校正
      headers.set("cache-control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
      return new Response(request.method === "HEAD" ? null : injectDetailMeta(html, meta), { status: 200, headers });
    }
  }

  if (APP_ROUTES.some((route) => route.test(pathname))) return next();

  // 其余路径：交付单页应用，但状态码用 404，前端路由会渲染 404 提示
  const asset = await env.ASSETS.fetch(new URL("/index.html", request.url));
  const headers = new Headers(asset.headers);
  // 以后这些路径可能真的被建出来，别让 404 结果留在缓存里
  headers.set("cache-control", "no-store");
  return new Response(asset.body, { status: 404, headers });
}
