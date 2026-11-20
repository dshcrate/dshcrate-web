/**
 * 匿名每日计数接口（Cloudflare Pages Function，路由 /api/telemetry）。
 *
 * 插件端默认关闭；用户主动开启后，每个安装每个 UTC 日最多提交一次。
 * 只存 5 个字段：随机安装编号、插件版本、DSH 版本、桌面端/网页端、下载区域。
 * 不读取、不保存 IP、UA 或任何其他请求头。
 *
 * 环境变量 / 绑定：
 *   DB  D1 数据库，表结构见 telemetry/schema.sql
 */

interface Env {
  DB?: D1Like;
}

/** 只声明用到的 D1 方法，避免为 Functions 引入整套 workers-types。 */
interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

interface Ctx {
  request: Request;
  env: Env;
}

export interface Ping {
  id: string;
  v: string;
  hv: string | null;
  kind: "desktop" | "web";
  region: string;
}

const ID = /^[0-9a-f]{32}$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,40}$/;
const KIND = new Set(["desktop", "web"]);
const REGION = /^[a-z]{2,10}$/;

/**
 * 校验并收窄请求体。
 * 入参：value 为 JSON.parse 的结果
 * 返回：合法时返回只含五个字段的对象；否则返回 null
 */
export function validatePing(value: unknown): Ping | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, v, hv, kind, region } = value as Record<string, unknown>;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof v !== "string" || !VERSION.test(v)) return null;
  if (!(hv === null || (typeof hv === "string" && VERSION.test(hv)))) return null;
  if (typeof kind !== "string" || !KIND.has(kind)) return null;
  if (typeof region !== "string" || !REGION.test(region)) return null;
  return { id, v, hv, kind: kind as Ping["kind"], region };
}

/** 处理一次上报。重复的 (day, id) 由主键忽略，仍返回 204。 */
export async function onRequest({ request, env }: Ctx): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (!env.DB) return new Response(null, { status: 503 });

  const text = await request.text();
  if (text.length > 1024) return new Response(null, { status: 413 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const ping = validatePing(parsed);
  if (ping === null) return new Response(null, { status: 400 });

  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO pings (day, id, v, hv, kind, region) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(day, ping.id, ping.v, ping.hv, ping.kind, ping.region)
      .run();
  } catch {
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
