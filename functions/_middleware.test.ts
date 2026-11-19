import assert from "node:assert/strict";
import { test } from "node:test";
import { detailMeta, injectDetailMeta, isGonePath, isSitemapPath, onRequest } from "./_middleware.ts";

/** 正常场景：索引、静态页分片、详情页分片都应命中。 */
test("isSitemapPath 命中 sitemap 路径", () => {
  for (const pathname of ["/sitemap.xml", "/sitemap-pages.xml", "/sitemap-1.xml", "/sitemap-15.xml"]) {
    assert.equal(isSitemapPath(pathname), true, pathname);
  }
});

/** 边界场景：前缀相似、带后缀、大小写不同的路径不能误判。 */
test("isSitemapPath 不误伤相近路径", () => {
  const pathnames = [
    "/",
    "/top",
    "/p/a/b",
    "/data/sitemap-1.xml",
    "/sitemap.xml.bak",
    "/sitemap-old.xml",
    "/sitemap-1.XML",
    "/assets/a.js",
  ];
  for (const pathname of pathnames) assert.equal(isSitemapPath(pathname), false, pathname);
});

/** 异常场景：空串与残缺路径不应抛错。 */
test("isSitemapPath 处理空值与残缺路径", () => {
  assert.equal(isSitemapPath(""), false);
  assert.equal(isSitemapPath("/sitemap-.xml"), false);
  assert.equal(isSitemapPath("/sitemap.xml/"), false);
});

/** 已删除的验证文件必须返回 410，不能再落到静态资源或边缘缓存。 */
test("isGonePath：已删除的验证文件", () => {
  assert.equal(isGonePath("/sogousiteverification.txt"), true);
  assert.equal(isGonePath("/baidu_verify_codeva-iFJaJ0PAjx.html"), true);
  assert.equal(isGonePath("/sitemap-1.xml"), false);
  assert.equal(isGonePath("/"), false);
});

/** 正常场景：详情页的标题与描述由 URL 生成，每个仓库各不相同。 */
test("detailMeta：为详情页生成唯一的标题、描述与 canonical", () => {
  const meta = detailMeta("/p/MengXinSu/floor-limiter");
  assert.ok(meta);
  assert.match(meta.title, /floor-limiter/);
  assert.match(meta.description, /MengXinSu\/floor-limiter/);
  assert.equal(meta.canonical, "https://dshcrate.com/p/MengXinSu/floor-limiter");
});

/** 边界场景：结尾斜杠与百分号编码都要还原成可读文本。 */
test("detailMeta：处理结尾斜杠与 URL 编码", () => {
  const meta = detailMeta("/p/a%20b/c%2Bd/");
  assert.ok(meta);
  assert.match(meta.title, /c\+d/);
  assert.match(meta.description, /a b\/c\+d/);
  assert.equal(meta.canonical, "https://dshcrate.com/p/a%20b/c%2Bd");
});

/** 非详情页路径不能误命中。 */
test("detailMeta：只命中 /p/owner/repo", () => {
  for (const pathname of ["/", "/top", "/p/only-owner", "/p/a/b/c", "/data/dsh-crate.json"]) {
    assert.equal(detailMeta(pathname), null, pathname);
  }
});

/** 异常场景：非法百分号编码不应抛错，保留原样即可。 */
test("detailMeta：非法编码不抛错", () => {
  const meta = detailMeta("/p/%E0%A4%A/repo");
  assert.ok(meta);
  assert.match(meta.title, /repo/);
});

/** 注入后 head 里的固定标签应全部指向本页，正文保持不变。 */
test("injectDetailMeta：改写标题、描述、og 与 canonical", () => {
  const html = [
    "<!doctype html><html><head>",
    "<title>DSH 插件箱子</title>",
    '<meta name="description" content="旧描述" />',
    '<meta property="og:title" content="旧标题" />',
    '<meta property="og:description" content="旧描述" />',
    '<meta property="og:url" content="https://dshcrate.com/" />',
    '<meta name="twitter:title" content="旧标题" />',
    '<meta name="twitter:description" content="旧描述" />',
    "</head><body><div id=\"root\"></div></body></html>",
  ].join("");
  const meta = detailMeta("/p/owner/repo")!;
  const next = injectDetailMeta(html, meta);
  assert.ok(next.includes(`<title>${meta.title}</title>`));
  assert.ok(next.includes(`<meta name="description" content="${meta.description}" />`));
  assert.ok(next.includes(`<meta property="og:url" content="${meta.canonical}" />`));
  assert.equal((next.match(/rel="canonical"/g) ?? []).length, 1);
  assert.ok(next.includes('<div id="root"></div>'));
  assert.ok(!next.includes("旧标题"));
  assert.ok(!next.includes("旧描述"));
});

/** 安全场景：URL 里的尖括号必须转义，不能拼出可执行的标签。 */
test("injectDetailMeta：标题里的特殊字符被转义", () => {
  const meta = detailMeta("/p/owner/%3Cscript%3E")!;
  const next = injectDetailMeta("<title>old</title>", meta);
  assert.ok(next.includes("&lt;script&gt;"));
  assert.ok(!next.includes("<title><script>"));
});

/** 集成场景：详情页请求返回 200，且 HTML 已带上本页 meta。 */
test("onRequest：详情页交付注入后的入口 HTML", async () => {
  const html = '<title>old</title><meta name="description" content="old" />';
  const context = {
    request: new Request("https://dshcrate.com/p/owner/repo"),
    env: {
      ASSETS: {
        fetch: async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
      },
    },
    next: async () => new Response("next"),
  };
  const response = await onRequest(context as never);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /owner\/repo/);
  assert.match(body, /canonical/);
});
