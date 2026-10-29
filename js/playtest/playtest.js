/**
 * 試玩紀錄（資料部分）
 *
 * 每局記下試玩者、時間、每回合秒數、出了哪些牌、結果等，存到瀏覽器 localStorage（見 PlaytestStore），
 * 在 ?debug=1 的試玩設定面板可匯出成 CSV（Excel 可直接開啟）。
 */

/**
 * 試玩紀錄在 localStorage 的名稱。
 */
export const PLAYTEST_STORAGE_KEY = "iso45003.playtest.v1";

/**
 * 匯出 CSV 的欄位標題。
 */
const PLAYTEST_CSV_HEADERS = [
  "試玩者",
  "開始時間",
  "局長秒",
  "結束回合",
  "結果",
  "留任人數",
  "離職人數",
  "傾聽次數",
  "對症次數",
  "同類次數",
  "無關次數",
  "長期措施次數",
  "換牌次數",
  "每回合秒數",
  "員工特質組合",
  "種子",
  "特殊事件開關",
  "同面向加成開關",
  "事件id",
  "配錯矩陣",
];

/**
 * 出牌結果在 CSV 裡顯示的中文。
 */
const PLAY_RESULT_LABELS = {
  exact: "對症",
  category: "同類",
  unrelated: "無關",
};

/**
 * 開始記錄一局新的試玩。
 */
export function createPlaytest(options) {
  const now = options.now ?? Date.now();
  return {
    tester: options.tester.trim() || "unknown",
    seed: options.seed,
    specialEvents: options.specialEvents === true,
    sameCategoryCombo: options.sameCategoryCombo === true,
    startedAtMs: now,
    currentRound: 1,
    roundStartedAtMs: now,
    roundSeconds: [],
    plays: [],
    saved: false,
  };
}

/**
 * 記下一次出牌（對症 / 同類 / 無關）。
 */
export function recordPlaytestPlay(playtest, play) {
  if (!playtest.saved) {
    playtest.plays.push({
      cardId: play.cardId,
      targetHazardId: play.targetHazardId,
      result: play.result,
    });
  }
}

/**
 * 把出牌紀錄轉成 CSV 欄位用的文字：卡牌:風險:結果|…
 */
function formatPlaytestPlays(plays) {
  return plays
    .map((play) => `${play.cardId}:${play.targetHazardId}:${PLAY_RESULT_LABELS[play.result]}`)
    .join("|");
}

/**
 * 進入新回合時，把上一回合花的秒數記下來。
 */
export function advancePlaytestRound(playtest, round, now = Date.now()) {
  if (!playtest.saved) {
    if (round !== playtest.currentRound) {
      addRoundSeconds(playtest, now);
      playtest.currentRound = round;
      playtest.roundStartedAtMs = now;
    }
  }
}

/**
 * 結束這局，產生一筆完整的試玩紀錄（之後再呼叫 recordPlaytestPlay 也不會再記）。
 */
export function finishPlaytest(playtest, summary) {
  const now = summary.now ?? Date.now();
  addRoundSeconds(playtest, now);
  playtest.saved = true;
  return {
    tester: playtest.tester,
    startedAt: new Date(playtest.startedAtMs).toISOString(),
    durationSeconds: Math.max(0, Math.round((now - playtest.startedAtMs) / 1000)),
    endedRound: summary.endedRound,
    result: summary.result,
    retained: summary.retained,
    resigned: summary.resigned,
    listening: summary.listening,
    exact: summary.exact,
    category: summary.category,
    unrelated: summary.unrelated,
    longTerm: summary.longTerm,
    rerolls: summary.rerolls,
    roundSeconds: playtest.roundSeconds.slice(),
    roster: summary.roster,
    seed: playtest.seed,
    specialEvents: playtest.specialEvents,
    sameCategoryCombo: playtest.sameCategoryCombo,
    eventIds: (summary.eventIds ?? []).slice(),
    plays: (summary.plays ?? playtest.plays).slice(),
  };
}

/**
 * 把多筆試玩紀錄轉成 CSV 文字（開頭加 BOM，Excel 才能正確顯示中文）。
 */
export function playtestRecordsToCsv(records) {
  return `\uFEFF${[
    PLAYTEST_CSV_HEADERS.join(","),
    ...records.map((record) =>
      [
        record.tester,
        record.startedAt,
        record.durationSeconds,
        record.endedRound,
        record.result,
        record.retained,
        record.resigned,
        record.listening,
        record.exact,
        record.category,
        record.unrelated,
        record.longTerm,
        record.rerolls,
        record.roundSeconds.join("|"),
        record.roster,
        record.seed,
        record.specialEvents === true,
        record.sameCategoryCombo === true,
        (record.eventIds ?? []).join("|"),
        formatPlaytestPlays(record.plays ?? []),
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join(`\r
`)}`;
}

/**
 * 累加目前回合花的秒數。
 */
function addRoundSeconds(playtest, now) {
  const roundIndex = Math.max(0, playtest.currentRound - 1);
  const seconds = Math.max(0, Math.round((now - playtest.roundStartedAtMs) / 1000));
  playtest.roundSeconds[roundIndex] = (playtest.roundSeconds[roundIndex] ?? 0) + seconds;
}

/**
 * CSV 欄位跳脫：含逗號、引號或換行時加上雙引號。
 */
function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
