/**
 * 網址參數
 *
 *   ?tester=名字   試玩紀錄裡的試玩者名稱
 *   ?seed=12345    固定隨機種子（同一個種子，發牌與壓力完全相同）
 *   ?demo=1        示範模式：沒指定種子時用 45003 起算的固定種子
 *   ?debug=1       顯示試玩設定面板（功能開關、匯出 / 清除試玩紀錄）
 *   ?e2e=1         自動測試模式：關閉動畫與音效，並提供 window.__EXHIBIT_E2E__ 給測試程式操作
 *   ?autostart=1   跳過開始畫面直接開局（在 GameScene.create 裡判斷）
 */

/**
 * ?tester= 的值，沒填時為 "unknown"。
 */
export function getTesterName(query = "") {
  const tester = toSearchParams(query).get("tester")?.trim();
  return tester || "unknown";
}

/**
 * 是否為除錯模式（?debug=1）。
 */
export function isDebugMode(query = "") {
  return isQueryFlagOn(query, "debug");
}

/**
 * 是否為自動測試模式（?e2e=1）。
 */
export function isE2EMode(query = "") {
  return isQueryFlagOn(query, "e2e");
}

/**
 * ?seed= 的值；必須是 1 到 2147483646 的整數，否則視為沒指定。
 */
export function getSeedFromQuery(query = "") {
  const rawSeed = toSearchParams(query).get("seed")?.trim();
  if (!rawSeed || !/^\d+$/.test(rawSeed)) return;
  const seed = Number(rawSeed);
  if (!(!Number.isInteger(seed) || seed < 1 || seed > 2147483646)) return seed;
}

/**
 * 決定這一局的種子：優先用 ?seed=；示範模式用 45003 + 第幾局；都沒有則回傳 undefined（隨機）。
 */
export function resolveSeed(query = "", demoOffset = 0) {
  const explicitSeed = getSeedFromQuery(query);
  if (explicitSeed !== undefined) return explicitSeed;
  if (isQueryFlagOn(query, "demo")) return 45003 + demoOffset;
}

/**
 * 網址參數是否為開啟（1 / true / yes）。
 */
function isQueryFlagOn(query, flagName) {
  const value = toSearchParams(query).get(flagName)?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * 接受字串或 URLSearchParams，統一轉成 URLSearchParams。
 */
function toSearchParams(query) {
  return typeof query == "string" ? new URLSearchParams(query.startsWith("?") ? query : `?${query}`) : query;
}
