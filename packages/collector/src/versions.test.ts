import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginEntry } from "@dsh-crate/schema";
import { resolveVersions } from "./versions.ts";

/** 构造一条最小条目：只填版本解析用到的字段。 */
function entry(patch: Partial<PluginEntry> = {}): PluginEntry {
  return {
    id: "o/one",
    name: "one",
    fullName: "o/one",
    ecosystem: "dsh",
    type: "cordis-plugin",
    stars: 1,
    description: "",
    descriptionZh: null,
    tags: [],
    curated: false,
    homepage: null,
    pushedAt: null,
    version: null,
    downloads: null,
    install: {
      method: "pnpm-profile",
      command: null,
      packageName: "some-plugin",
      enginesDsh: null,
      needsConfig: false,
      risky: false,
    },
    score: { maintenance: 0, utility: 0, popularity: 0, convenience: 0, total: 0 },
    sources: ["topic"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "versions-"));
}

/** 替换 fetch，记录请求 URL；调用方负责 restore。 */
function stubFetch(answer: (url: string) => Response | Promise<Response>): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return answer(url);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

test("resolveVersions：首次查询回填版本并写入缓存", async () => {
  const dir = tempDir();
  const fetchStub = stubFetch(() => json({ version: "1.2.3" }));
  try {
    const item = entry();
    const result = await resolveVersions([item], dir);
    assert.equal(item.version, "1.2.3");
    assert.deepEqual(result, { hits: 1, cached: 0, queried: 1, failed: 0 });
    const cache = JSON.parse(readFileSync(join(dir, "versions-cache.json"), "utf8")) as Record<string, { v: string; t: string }>;
    assert.equal(cache["npm:some-plugin"]?.v, "1.2.3");
  } finally {
    fetchStub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVersions：TTL 内直接命中缓存，不再发请求", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "versions-cache.json"), JSON.stringify({ "npm:some-plugin": { v: "2.0.0", t: daysAgo(0) } }));
  const fetchStub = stubFetch(() => json({ version: "9.9.9" }));
  try {
    const item = entry();
    const result = await resolveVersions([item], dir);
    assert.equal(item.version, "2.0.0");
    assert.equal(fetchStub.calls.length, 0);
    assert.deepEqual(result, { hits: 1, cached: 1, queried: 0, failed: 0 });
  } finally {
    fetchStub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVersions：缓存过期后重查并升级版本", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "versions-cache.json"), JSON.stringify({ "npm:some-plugin": { v: "1.0.0", t: daysAgo(2) } }));
  const fetchStub = stubFetch(() => json({ version: "1.4.0" }));
  try {
    const item = entry({ version: "1.0.0" });
    const result = await resolveVersions([item], dir);
    assert.equal(item.version, "1.4.0");
    assert.equal(result.queried, 1);
    const cache = JSON.parse(readFileSync(join(dir, "versions-cache.json"), "utf8")) as Record<string, { v: string }>;
    assert.equal(cache["npm:some-plugin"]?.v, "1.4.0");
  } finally {
    fetchStub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVersions：查询失败保留旧版本，缓存不动", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "versions-cache.json"), JSON.stringify({ "npm:some-plugin": { v: "1.0.0", t: daysAgo(2) } }));
  const fetchStub = stubFetch(() => json({ error: "boom" }, 500));
  try {
    const item = entry({ version: "1.0.0" });
    const result = await resolveVersions([item], dir);
    assert.equal(item.version, "1.0.0");
    // 5xx 会重试一次，仍失败才放弃
    assert.equal(fetchStub.calls.length, 2);
    assert.equal(result.failed, 1);
    const cache = JSON.parse(readFileSync(join(dir, "versions-cache.json"), "utf8")) as Record<string, { v: string }>;
    assert.equal(cache["npm:some-plugin"]?.v, "1.0.0");
  } finally {
    fetchStub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVersions：首次请求失败后重试成功", async () => {
  const dir = tempDir();
  let round = 0;
  const fetchStub = stubFetch(() => {
    round += 1;
    return round === 1 ? json({ error: "busy" }, 503) : json({ version: "0.5.1" });
  });
  try {
    const item = entry({ version: "0.5.0" });
    const result = await resolveVersions([item], dir);
    assert.equal(item.version, "0.5.1");
    assert.equal(fetchStub.calls.length, 2);
    assert.deepEqual(result, { hits: 1, cached: 0, queried: 1, failed: 0 });
    const cache = JSON.parse(readFileSync(join(dir, "versions-cache.json"), "utf8")) as Record<string, { v: string }>;
    assert.equal(cache["npm:some-plugin"]?.v, "0.5.1");
  } finally {
    fetchStub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVersions：404 属确定性失败，不重试", async () => {
  const dir = tempDir();
  const fetchStub = stubFetch(() => json({ error: "not found" }, 404));
  try {
    const item = entry();
    const result = await resolveVersions([item], dir);
    assert.equal(item.version, null);
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(result.failed, 1);
  } finally {
    fetchStub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVersions：安装规格钉死版本时不发请求", async () => {
  const dir = tempDir();
  const fetchStub = stubFetch(() => json({ version: "9.9.9" }));
  try {
    const item = entry({
      install: { ...entry().install, packageName: "pinned-plugin@0.4.2" },
    });
    const result = await resolveVersions([item], dir);
    assert.equal(item.version, "0.4.2");
    assert.equal(fetchStub.calls.length, 0);
    assert.equal(result.queried, 0);
    assert.equal(existsSync(join(dir, "versions-cache.json")), false);
  } finally {
    fetchStub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVersions：github 规格读仓库 package.json 并写缓存", async () => {
  const dir = tempDir();
  const fetchStub = stubFetch(url => {
    assert.match(url, /raw\.githubusercontent\.com\/o\/one\/HEAD\/package\.json$/);
    return json({ version: "3.1.0" });
  });
  try {
    const item = entry({
      fullName: "o/one",
      install: { ...entry().install, packageName: "github:o/one" },
    });
    await resolveVersions([item], dir);
    assert.equal(item.version, "3.1.0");
    const cache = JSON.parse(readFileSync(join(dir, "versions-cache.json"), "utf8")) as Record<string, { v: string }>;
    assert.equal(cache["gh:o/one"]?.v, "3.1.0");
  } finally {
    fetchStub.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
