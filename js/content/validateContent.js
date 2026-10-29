/**
 * 遊戲資料檢查
 *
 * 啟動時檢查 public/data/ 的資料是否彼此對得上。任何一項不符合就丟出錯誤，
 * 畫面會顯示「遊戲無法啟動」與這裡寫的原因，方便修改 JSON 的人知道哪裡填錯。
 */

/**
 * 檢查遊戲資料，有錯就丟出錯誤。檢查項目：
 * - 風險、卡牌、員工的 id 不可重複；至少 3 種風險、3 名員工
 * - 所有資料都要標記 _reviewStatus: "draft"
 * - 每張行動卡都要對應到存在的風險；每種風險都要有對應行動卡與泡泡文字
 * - 特殊事件 id 不重複、對應的風險存在
 * - 員工專屬泡泡要對應到存在的員工與風險
 * - 回合數、手牌上限 > 0；對症抽牌機率在 0–1 之間
 * - 留任星等要完整設定 1、2、3 人
 * - 抽牌數與行動次數要涵蓋最多員工人數
 * - 每一回合都要有對應的平衡設定（balance.rounds）
 */
export function validateContent(content) {
  const hazardIds = new Set(content.hazards.map((hazard) => hazard.id));
  const cardIds = new Set(content.cards.map((card) => card.id));
  const employeeIds = new Set(content.employees.map((employee) => employee.id));
  if (hazardIds.size !== content.hazards.length) throw new Error("風險資料含有重複 id。");
  if (cardIds.size !== content.cards.length) throw new Error("卡牌資料含有重複 id。");
  if (employeeIds.size !== content.employees.length) throw new Error("員工資料含有重複 id。");
  if (content.hazards.length < 3) throw new Error("至少需要三種風險。");
  if (content.employees.length < 3) throw new Error("至少需要三名員工設定。");
  if (
    content.balance._reviewStatus !== "draft" ||
    content.bubbles._reviewStatus !== "draft" ||
    [...content.hazards, ...content.cards, ...content.employees].some(
      (item) => item._reviewStatus !== "draft",
    ) ||
    [...content.bubbles.hazards, ...content.bubbles.employees].some(
      (bubble) => bubble._reviewStatus !== "draft",
    )
  )
    throw new Error("所有內容資料都必須標記為 draft。");
  for (const card of content.cards) {
    const isManagerCard = card.kind === "consultant" || card.kind === "review";
    if (!Number.isInteger(card.count) || card.count < 0 || (!isManagerCard && card.count < 1))
      throw new Error(`卡牌 ${card.id} 的數量設定無效。`);
    if (card.kind === "action" && (!card.hazardId || !hazardIds.has(card.hazardId)))
      throw new Error(`行動卡 ${card.id} 沒有有效的對應風險。`);
  }
  for (const hazard of content.hazards) {
    if (!content.cards.some((card) => card.kind === "action" && card.hazardId === hazard.id))
      throw new Error(`風險 ${hazard.id} 缺少對應行動卡。`);
    if (!content.bubbles.hazards.some((bubble) => bubble.hazardId === hazard.id))
      throw new Error(`風險 ${hazard.id} 缺少完整泡泡文字。`);
  }
  if (content.events) {
    if (new Set(content.events.map((event) => event.id)).size !== content.events.length)
      throw new Error("特殊事件資料含有重複 id。");
    for (const event of content.events) {
      if (event._reviewStatus !== "draft") throw new Error(`特殊事件 ${event.id} 必須標記為 draft。`);
      if (!event.hazardId || !hazardIds.has(event.hazardId))
        throw new Error(`特殊事件 ${event.id} 的風險不存在。`);
    }
  }
  for (const bubble of content.bubbles.employees)
    if (!employeeIds.has(bubble.employeeId) || !hazardIds.has(bubble.hazardId))
      throw new Error(`員工專屬泡泡 ${bubble.employeeId}/${bubble.hazardId} 對應無效。`);
  const { balance } = content;
  if (balance.totalRounds < 1 || balance.handLimit < 1) throw new Error("回合、行動與手牌上限必須大於 0。");
  if (balance.matchDrawChance < 0 || balance.matchDrawChance > 1)
    throw new Error("對症抽牌機率必須介於 0 與 1 之間。");
  if (
    balance.retentionRatings.length !== 3 ||
    [1, 2, 3].some(
      (count) =>
        !balance.retentionRatings.some(
          (rating) =>
            rating.retainedEmployees === count && rating.stars === count && rating._reviewStatus === "draft",
        ),
    )
  )
    throw new Error("留任星等必須完整設定 1–3 人。");
  const maxEmployees = Math.max(...balance.rounds.map((range) => range.employeeCount));
  for (const [label, values] of [
    ["抽牌數", balance.drawByEmployees],
    ["行動次數", balance.playsByEmployees],
  ])
    if (
      values.length < maxEmployees ||
      values.slice(0, maxEmployees).some((value) => !Number.isInteger(value) || value < 1)
    )
      throw new Error(`${label}必須涵蓋 1–${maxEmployees} 名員工，且皆為正整數。`);
  for (let round = 1; round <= balance.totalRounds; round += 1)
    if (!balance.rounds.some((range) => round >= range.from && round <= range.to))
      throw new Error(`第 ${round} 回合缺少平衡設定。`);
}
