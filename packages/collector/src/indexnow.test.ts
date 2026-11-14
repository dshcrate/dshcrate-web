import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PluginEntry } from "@dsh-crate/schema";
import { loadSiteConfig, REPO_ROOT } from "./config.ts";
import { chunkUrls, mergePending, pushIndexNow, readPending, selectIndexNowUrls, writePending } from "./indexnow.ts";

const ORIGIN = "https://dshcrate.com";

/** 构造最小可用条目，只覆盖用例关心的字段。 */
function makeEntry(overrides: Partial<PluginEntry> & { id: string }): PluginEntry {
  const repo = overrides.id.split("/")[1] ?? overrides.id;
  const base: PluginEntry = {
    id: overrides.id,
    name: repo,
    fullName: overrides.id,
    ecosystem: "dsh",
    type: "cordis-plugin",
    stars: 0,
    description: "desc",
    descriptionZh: null,
    tags: [],
    curated: false,
    homepage: null,
    pushedAt: null,
    version: null,
    downloads: null,
    install: {
      method: "pnpm-profile",
      command: "dsh plugin --profile web add pkg",
      packageName: "pkg",
      enginesDsh: null,
      needsConfig: false,
      risky: false,
    },
    score: { maintenance: 0, utility: 0, popularity: 0, convenience: 0, total: 0 },
    sources: ["mirror"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

/** 正常场景：新增与实质变更入列，未变化不入列。 */
test("selectIndexNowUrls：新增与实质变更入列", () => {
  const stable = makeEntry({ id: "a/stable" });
  const prev = [stable, makeEntry({ id: "a/changed", version: "1.0.0" })];
  const next = [
    stable,
    makeEntry({ id: "a/changed", version: "2.0.0" }),
    makeEntry({ id: "a/new" }),
  ];
  const result = selectIndexNowUrls(prev, next, ORIGIN);
  assert.deepEqual(result.urls, [`${ORIGIN}/p/a/changed`, `${ORIGIN}/p/a/new`]);
  assert.equal(result.added, 1);
  assert.equal(result.changed, 1);
  assert.equal(result.skippedNoBaseline, false);
});

/** 边界场景：只有星数、下载量、时间变化时不算变更。 */
test("selectIndexNowUrls：非实质字段变化不推送", () => {
  const prev = [makeEntry({ id: "a/one", stars: 1, tags: ["b", "a"] })];
  const next = [
    makeEntry({
      id: "a/one",
      stars: 999,
      downloads: 100,
      updatedAt: "2026-02-02T00:00:00.000Z",
      pushedAt: "2026-02-02T00:00:00.000Z",
      tags: ["a", "b"],
    }),
  ];
  const result = selectIndexNowUrls(prev, next, ORIGIN);
  assert.deepEqual(result.urls, []);
  assert.equal(result.changed, 0);
});

/** 异常场景：没有基线时不推送，避免一次灌四万条。 */
test("selectIndexNowUrls：无基线直接跳过", () => {
  const result = selectIndexNowUrls([], [makeEntry({ id: "a/one" })], ORIGIN);
  assert.deepEqual(result.urls, []);
  assert.equal(result.skippedNoBaseline, true);
});

/** 合并待推送列表时按出现顺序去重。 */
test("mergePending：去重且保留原顺序", () => {
  assert.deepEqual(mergePending(["u1", "u2"], ["u2", "u3"]), ["u1", "u2", "u3"]);
});

/** 分批按协议上限切分，非法批次大小直接报错。 */
test("chunkUrls：按上限分批", () => {
  const urls = Array.from({ length: 10_001 }, (_, index) => `https://example.com/${index}`);
  const batches = chunkUrls(urls);
  assert.deepEqual(batches.map((batch) => batch.length), [10_000, 1]);
  assert.throws(() => chunkUrls(urls, 0), /分批大小非法/);
});

/** 正常推送：请求体字段完整，成功后无失败列表。 */
test("pushIndexNow：请求体与成功状态", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const urls = [`${ORIGIN}/p/a/b`];
  const result = await pushIndexNow({
    host: "dshcrate.com",
    key: "d3105154d2d44d16909df778a137ec86",
    keyLocation: "https://dshcrate.com/key.txt",
    urls,
    fetchImpl,
    wait: async () => {},
  });
  assert.deepEqual(result.statuses, [200]);
  assert.deepEqual(result.failed, []);
  assert.equal(calls[0]?.url, "https://api.indexnow.org/indexnow");
  assert.equal(calls[0]?.body.host, "dshcrate.com");
  assert.deepEqual(calls[0]?.body.urlList, urls);
});

/** 异常场景：429 重试后成功；普通 4xx 不重试并保留 URL。 */
test("pushIndexNow：429 重试，400 直接失败", async () => {
  let attempts = 0;
  const retryFetch = (async () => {
    attempts++;
    return new Response("", { status: attempts === 1 ? 429 : 200 });
  }) as unknown as typeof fetch;
  const retried = await pushIndexNow({
    host: "dshcrate.com",
    key: "d3105154d2d44d16909df778a137ec86",
    keyLocation: "https://dshcrate.com/key.txt",
    urls: [`${ORIGIN}/p/a/b`],
    fetchImpl: retryFetch,
    wait: async () => {},
  });
  assert.equal(attempts, 2);
  assert.deepEqual(retried.statuses, [200]);

  let rejected = 0;
  const failFetch = (async () => {
    rejected++;
    return new Response("", { status: 400 });
  }) as unknown as typeof fetch;
  const failed = await pushIndexNow({
    host: "dshcrate.com",
    key: "d3105154d2d44d16909df778a137ec86",
    keyLocation: "https://dshcrate.com/key.txt",
    urls: [`${ORIGIN}/p/a/b`],
    fetchImpl: failFetch,
    wait: async () => {},
  });
  assert.equal(rejected, 1);
  assert.deepEqual(failed.statuses, [400]);
  assert.deepEqual(failed.failed, [`${ORIGIN}/p/a/b`]);
});

/** 读写待推送文件：缺失、损坏与非法 URL 都按空处理。 */
test("readPending / writePending：容错与回读", () => {
  const dir = mkdtempSync(join(tmpdir(), "indexnow-"));
  try {
    const file = join(dir, "pending.json");
    assert.deepEqual(readPending(file), []);
    writeFileSync(file, "{broken", "utf8");
    assert.deepEqual(readPending(file), []);
    writePending(file, ["https://dshcrate.com/p/a/b", "not-a-url"]);
    assert.deepEqual(readPending(file), ["https://dshcrate.com/p/a/b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 验证 key 文件与 site.config.json 保持一致，防止上线后 403。 */
test("IndexNow key 文件与配置一致", () => {
  const site = loadSiteConfig();
  assert.match(site.indexNowKey, /^[a-f0-9]{32}$/i);
  const keyFile = resolve(REPO_ROOT, "packages/web/public", `${site.indexNowKey}.txt`);
  assert.ok(existsSync(keyFile), `缺少 key 文件：${keyFile}`);
  assert.equal(readFileSync(keyFile, "utf8").trim(), site.indexNowKey);
});
