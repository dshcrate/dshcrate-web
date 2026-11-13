import assert from "node:assert/strict";
import { test } from "node:test";
import { isSitemapPath } from "./_middleware.ts";

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
