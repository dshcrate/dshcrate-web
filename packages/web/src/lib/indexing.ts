/**
 * 详情页的索引策略。
 *
 * 只有「确认未收录」（目录与反查表里都没有这个仓库）才输出 noindex。
 * 加载失败（超时、部署窗口、网络错误）不代表页面不存在：把它也标成
 * noindex 会把有效插件页从搜索结果里剔除（2026-11-19 GSC 误伤 1,276 页）。
 */
export type DetailLoadState = "loading" | "ok" | "missing" | "error";

/**
 * 详情页是否应该输出 noindex。
 *
 * 入参：state —— 详情页当前的加载状态。
 * 返回：仅在 missing 时为 true；error 表示「不知道」，交给重试而不是判死。
 */
export function detailShouldNoindex(state: DetailLoadState): boolean {
  return state === "missing";
}
