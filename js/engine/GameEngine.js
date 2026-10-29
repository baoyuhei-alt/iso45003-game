/**
 * 遊戲規則核心
 *
 * 這個檔案只處理規則與資料（回合、員工、壓力、手牌、計分），完全不碰畫面，
 * 所以可以單獨測試（見 tests/engine-trace.mjs）。畫面由 scene/GameScene.js 負責，
 * 它呼叫這裡的 playCard()、listen()、endRound() 等方法，再依 state 重畫。
 *
 * 所有隨機（洗牌、壓力分配、事件）都來自 seed，同一個 seed 一定得到同樣的局面。
 */

/**
 * 一局開始時的統計數字（全部歸零），用於結算畫面與試玩紀錄。
 */
export const createEmptyMetrics = () => ({
  exact: 0,
  category: 0,
  unrelated: 0,
  counseling: 0,
  listening: 0,
  longTerm: 0,
  rerolls: 0,
  exactByCategory: {
    workDesign: 0,
    social: 0,
    environment: 0,
  },
  missedHazards: {},
});

/**
 * 一局遊戲的規則與狀態。
 *
 * 用法：const engine = new GameEngine(content, seed);
 *      engine.listen(員工)、engine.playCard(卡牌, 員工)、engine.endRound() …
 *      畫面依 engine.state 繪製。
 *
 * 規則若不允許（例如行動次數用完），方法會丟出 Error，訊息會直接顯示給玩家。
 */
export class GameEngine {
  content;

  /**
   * 目前局面，畫面完全依這個物件繪製。主要欄位：
   *   round 第幾回合、phase "action"（進行中）或 "result"（已結束）、endReason 結束原因
   *   employees 在場員工（mood 心情、pressures 壓力、effects 長期措施）
   *   hand 手牌、deck 牌庫、discard 棄牌堆、managementTool 本回合的顧問卡（偶數回合才有）
   *   playsRemaining 剩餘行動次數、listeningAvailable / rerollAvailable 本回合能否傾聽 / 換牌
   *   lastMessage 畫面下方顯示的訊息、metrics 統計數字、activeEvent 本回合特殊事件
   */
  state;
  seed;

  /**
   * 依 seed 產生的亂數函式；所有隨機都必須透過它，才能重現同一局。
   */
  random;
  nextInstanceId = 1;
  nextPressureId = 1;

  /**
   * 員工出場順序（開局時洗牌決定）。
   */
  employeeOrder = [];

  /**
   * 已離職員工的設定 id；離職的人不會再回來。
   */
  departedDefinitions = new Set();

  /**
   * 本局出現過的員工設定 id（依出場順序）。
   */
  appearedDefinitions = [];

  /**
   * 本回合每位員工在各面向的對症次數（同面向加成用）。
   */
  exactCategoryCounts = new Map();

  /**
   * 特殊事件給的額外行動次數。
   */
  eventBonusActions = 0;
  constructor(content, seed) {
    this.content = content;
    this.seed = seed ?? Math.floor(Math.random() * 2147483646) + 1;
    this.random = this.seededRandom(this.seed);
    this.reset();
  }

  /**
   * 重新開局（可指定新種子）：洗員工順序與牌庫、安排第一回合的員工、壓力與手牌。
   */
  reset(seed) {
    if (seed !== undefined) {
      this.seed = seed;
      this.random = this.seededRandom(seed);
    }
    this.nextInstanceId = 1;
    this.nextPressureId = 1;
    this.employeeOrder = this.content.employees.map((employee) => employee.id);
    this.departedDefinitions.clear();
    this.appearedDefinitions = [];
    this.exactCategoryCounts.clear();
    this.eventBonusActions = 0;
    this.shuffle(this.employeeOrder);
    this.state = {
      round: 1,
      employees: [],
      hand: [],
      managementTool: this.createManagementTool(1),
      deck: this.createDeck(),
      discard: [],
      listeningAvailable: true,
      rerollAvailable: false,
      playsRemaining: 0,
      resigned: 0,
      completedRounds: 0,
      phase: "action",
      lastDepartures: [],
      lastPreventions: [],
      metrics: createEmptyMetrics(),
      lastMessage: "教學：先把「傾聽」交給員工，找出尚未說出的壓力。",
      lastCombo: false,
      occurredEventIds: [],
    };
    this.shuffle(this.state.deck);
    this.fillEmployees();
    this.state.playsRemaining = this.actionLimit();
    this.addRoundPressures();
    this.drawOpeningMatches();
  }

  /**
   * 打出一張牌（手牌或顧問卡）給一位員工。依卡牌種類：
   * - 顧問（consultant）：不需要員工，抽 2 張牌
   * - 輔導（counseling）：心情 +3，但壓力不變
   * - 行動卡（action）：
   *     對症：員工有這項壓力 → 整項清除
   *     同類：沒有這項，但有同面向的壓力 → 點數最高的那項降 1 點
   *     無關：都沒有 → 心情 +1
   *   長期措施（longTerm）另外會從下一回合起每回合預防 1 點，持續 balance.longTermDuration 回合；
   *   若是對症，心情再 +1。
   * 回傳 { result, message, cardId, targetHazardId }，result 為 exact / category / unrelated / counseling / consultant。
   */
  playCard(cardInstanceId, employeeInstanceId) {
    this.state.lastCombo = false;
    this.assertCanPlay();
    const handIndex = this.state.hand.findIndex((handCard) => handCard.instanceId === cardInstanceId);
    const isManagementTool = this.state.managementTool?.instanceId === cardInstanceId;
    if (handIndex < 0 && !isManagementTool) throw new Error("找不到這張手牌。");
    const cardInstance = isManagementTool ? this.state.managementTool : this.state.hand[handIndex];
    const card = this.card(cardInstance.definitionId);
    if (card.kind === "consultant") {
      if (isManagementTool) {
        this.state.managementTool = undefined;
      } else {
        this.state.hand.splice(handIndex, 1);
        this.state.discard.push(cardInstance);
      }
      this.consumePlay();
      this.draw(2);
      return this.message("consultant", "顧問提供新觀點：抽了 2 張牌。");
    }
    if (card.kind === "review") throw new Error("檢視流程需要先選擇要更換的手牌。");
    const employee = this.employee(employeeInstanceId);
    this.state.hand.splice(handIndex, 1);
    this.consumePlay();
    if (card.kind === "counseling") {
      employee.mood = Math.min(this.content.balance.maxMood, employee.mood + 3);
      this.state.discard.push(cardInstance);
      this.state.metrics.counseling += 1;
      return this.message(
        "counseling",
        `${this.employeeName(employee)}獲得支持，心情 +3；壓力來源仍需處理。`,
      );
    }
    const hazard = this.hazard(card.hazardId);
    const matchingPressure = employee.pressures.find((pressure) => pressure.hazardId === hazard.id);
    let outcome;
    let targetHazardId = "";
    if (matchingPressure) {
      targetHazardId = matchingPressure.hazardId;
      employee.pressures = employee.pressures.filter((pressure) => pressure.id !== matchingPressure.id);
      employee.resolvedHazardIds = [
        hazard.id,
        ...employee.resolvedHazardIds.filter((hazardId) => hazardId !== hazard.id),
      ];
      this.state.metrics.exact += 1;
      this.state.metrics.exactByCategory[hazard.category] += 1;
      outcome = this.message("exact", `對症！「${card.name}」清除了${hazard.name}。`);
    } else {
      const categoryPressure = employee.pressures
        .filter((pressure) => this.hazard(pressure.hazardId).category === hazard.category)
        .sort((a, b) => b.points - a.points || a.createdRound - b.createdRound || a.id - b.id)[0];
      if (categoryPressure) {
        targetHazardId = categoryPressure.hazardId;
        categoryPressure.points -= 1;
        if (categoryPressure.points <= 0) {
          employee.pressures = employee.pressures.filter((pressure) => pressure.id !== categoryPressure.id);
        }
        this.state.metrics.category += 1;
        outcome = this.message("category", "方向接近：同類壓力降低 1 點。");
      } else {
        targetHazardId =
          employee.pressures
            .slice()
            .sort((a, b) => b.points - a.points || a.createdRound - b.createdRound || a.id - b.id)[0]
            ?.hazardId ?? "";
        employee.mood = Math.min(this.content.balance.maxMood, employee.mood + 1);
        this.state.metrics.unrelated += 1;
        outcome = this.message("unrelated", "措施沒有處理目前風險，但關心讓心情 +1。");
      }
    }
    outcome.cardId = card.id;
    outcome.targetHazardId = targetHazardId;
    if (card.longTerm) {
      employee.effects.push({
        hazardId: hazard.id,
        remaining: this.content.balance.longTermDuration,
        activatedRound: this.state.round,
        sourceCard: cardInstance,
      });
      this.state.metrics.longTerm += 1;
      if (matchingPressure) {
        employee.mood = Math.min(this.content.balance.maxMood, employee.mood + 1);
        outcome.message += " 建立制度讓心情 +1。";
      }
      outcome.message += ` 從下一回合起預防 ${this.content.balance.longTermDuration} 回合。`;
      this.state.lastMessage = outcome.message;
    } else {
      this.state.discard.push(cardInstance);
    }
    if (outcome.result === "exact") {
      this.applySameCategoryCombo(employee, hazard.category, outcome);
    }
    return outcome;
  }

  /**
   * 打出「檢視流程」卡：把選定的最多 3 張手牌換掉，重新抽同樣張數。
   */
  playReview(reviewInstanceId, selectedInstanceIds) {
    this.assertCanPlay();
    const handIndex = this.state.hand.findIndex((handCard) => handCard.instanceId === reviewInstanceId);
    const isManagementTool = this.state.managementTool?.instanceId === reviewInstanceId;
    const reviewCard = isManagementTool ? this.state.managementTool : this.state.hand[handIndex];
    if (!reviewCard || this.card(reviewCard.definitionId).kind !== "review")
      throw new Error("找不到檢視流程卡。");
    const replaceIds = new Set(
      selectedInstanceIds.filter((instanceId) => instanceId !== reviewInstanceId).slice(0, 3),
    );
    const replacedCards = this.state.hand.filter((handCard) => replaceIds.has(handCard.instanceId));
    this.state.hand = this.state.hand.filter((handCard) => !replaceIds.has(handCard.instanceId));
    if (isManagementTool) {
      this.state.managementTool = undefined;
    } else {
      this.state.hand = this.state.hand.filter((handCard) => handCard.instanceId !== reviewInstanceId);
    }
    this.state.discard.push(...replacedCards);
    if (!isManagementTool) {
      this.state.discard.push(reviewCard);
    }
    this.consumePlay();
    this.draw(replacedCards.length);
    return this.message("review", `檢視流程：更換了 ${replacedCards.length} 張牌。`);
  }

  /**
   * 整手換牌：棄掉全部手牌重抽同樣張數。每回合一次，第 1 回合（教學）不能用。
   */
  rerollHand() {
    this.assertActive();
    if (!this.state.rerollAvailable) throw new Error("本回合已經重新盤點過了。");
    const oldHand = this.state.hand.splice(0);
    if (oldHand.length === 0) throw new Error("目前沒有可更換的手牌。");
    this.state.discard.push(...oldHand);
    this.state.rerollAvailable = false;
    this.state.metrics.rerolls += 1;
    this.draw(oldHand.length);
    return this.message("review", `整手換牌：重新抽取了 ${oldHand.length} 張牌。`);
  }

  /**
   * 傾聽一位員工：揭露他所有壓力與個人特質（之後的壓力也都公開），心情 +1。每回合一次，會用掉一次行動。
   */
  listen(employeeInstanceId) {
    this.state.lastCombo = false;
    this.assertCanPlay();
    if (!this.state.listeningAvailable) throw new Error("本回合已使用傾聽。");
    const employee = this.employee(employeeInstanceId);
    employee.traitRevealed = true;
    employee.pressures.forEach((pressure) => {
      pressure.hidden = false;
    });
    employee.mood = Math.min(this.content.balance.maxMood, employee.mood + 1);
    this.state.listeningAvailable = false;
    this.state.metrics.listening += 1;
    this.consumePlay();
    return this.message(
      "listening",
      `聽見了${this.employeeName(employee)}真正的困擾；本局後續壓力將保持公開，心情 +1。`,
    );
  }

  /**
   * 結算本回合：
   * 1. 長期措施：每項對應的壓力 -1 點（當回合才打出的不算），到期的措施卡回到棄牌堆
   * 2. 每位員工：沒有壓力 → 心情 +1；有壓力 → 心情扣掉剩餘壓力點數總和
   * 3. 心情歸 0 的員工離職
   * 4. 判斷結束：離職人數達上限 → resignations；沒人了 → empty；完成全部回合 → completed
   * 5. 否則進入下一回合：補員工、加新壓力、抽牌、可能出現特殊事件
   */
  endRound() {
    this.assertActive();
    this.state.lastDepartures = [];
    this.state.lastPreventions = [];
    for (const employee of this.state.employees) {
      employee.resolvedHazardIds = [];
      for (const effect of employee.effects) {
        if (effect.activatedRound >= this.state.round) continue;
        const pressure = employee.pressures.find((pressure) => pressure.hazardId === effect.hazardId);
        if (pressure) {
          pressure.points -= 1;
          this.state.lastPreventions.push({
            employeeInstanceId: employee.instanceId,
            hazardId: effect.hazardId,
            points: 1,
          });
          if (pressure.points <= 0) {
            employee.pressures = employee.pressures.filter((other) => other.id !== pressure.id);
          }
        }
        effect.remaining -= 1;
      }
      const expiredEffects = employee.effects.filter((effect) => effect.remaining <= 0);
      this.state.discard.push(...expiredEffects.map((effect) => effect.sourceCard));
      employee.effects = employee.effects.filter((effect) => effect.remaining > 0);
      const totalPressure = employee.pressures.reduce((sum, pressure) => sum + pressure.points, 0);
      if (totalPressure === 0) {
        employee.mood = Math.min(this.content.balance.maxMood, employee.mood + 1);
      } else {
        employee.mood = Math.max(0, employee.mood - totalPressure);
        for (const pressure of employee.pressures)
          this.state.metrics.missedHazards[pressure.hazardId] =
            (this.state.metrics.missedHazards[pressure.hazardId] ?? 0) + pressure.points;
      }
    }
    const departing = this.state.employees.filter((employee) => employee.mood <= 0);
    this.state.lastDepartures = departing.map((employee) => ({
      instanceId: employee.instanceId,
      definitionId: employee.definitionId,
      unresolvedHazardIds: employee.pressures
        .slice()
        .sort((a, b) => b.points - a.points)
        .map((pressure) => pressure.hazardId),
    }));
    departing.forEach((employee) => this.departedDefinitions.add(employee.definitionId));
    this.state.resigned += departing.length;
    this.state.employees = this.state.employees.filter((employee) => employee.mood > 0);
    this.state.completedRounds = this.state.round;
    if (this.state.resigned >= this.content.balance.resignationLimit) return this.finish("resignations");
    if (this.state.employees.length === 0) return this.finish("empty");
    if (this.state.round >= this.content.balance.totalRounds) return this.finish("completed");
    this.state.round += 1;
    this.state.listeningAvailable = true;
    this.state.rerollAvailable = true;
    this.state.managementTool = this.createManagementTool(this.state.round);
    this.fillEmployees();
    this.eventBonusActions = 0;
    this.addRoundPressures();
    this.draw(this.drawCount());
    this.exactCategoryCounts.clear();
    this.state.lastCombo = false;
    this.announceSpecialEvent();
    this.state.playsRemaining = this.actionLimit();
    if (!this.state.activeEvent) {
      this.state.lastMessage = `第 ${this.state.round} 回合：先確認每個人的壓力。`;
    }
  }

  /**
   * 總分 = 完成回合數 × 10 + 留任人數 × 20 + 所有人心情總和。
   */
  score() {
    const totalMood = this.state.employees.reduce((sum, employee) => sum + employee.mood, 0);
    return this.state.completedRounds * 10 + this.state.employees.length * 20 + totalMood;
  }

  /**
   * 依留任人數（1–3 人）取得結算星等與標語（balance.retentionRatings）。
   */
  retentionRating() {
    const retainedCount = Math.max(1, Math.min(3, this.state.employees.length));
    const rating = this.content.balance.retentionRatings.find(
      (candidate) => candidate.retainedEmployees === retainedCount,
    );
    if (!rating) throw new Error(`缺少留任 ${retainedCount} 人的星等設定。`);
    return rating;
  }

  /**
   * 本回合的行動次數：依在場員工人數查 balance.playsByEmployees，再加上事件獎勵。
   */
  actionLimit() {
    return (
      this.employeeScaledValue(this.content.balance.playsByEmployees, "行動次數") + this.eventBonusActions
    );
  }

  /**
   * 每回合抽牌數：依在場員工人數查 balance.drawByEmployees。
   */
  drawCount() {
    return this.employeeScaledValue(this.content.balance.drawByEmployees, "抽牌數");
  }

  /**
   * 抽牌（最多到手牌上限）。牌庫抽完會把棄牌堆洗回牌庫。回傳實際抽到的張數。
   */
  draw(count) {
    let drawn = 0;
    for (; drawn < count && this.state.hand.length < this.content.balance.handLimit;) {
      if (this.state.deck.length === 0) {
        if (this.state.discard.length === 0) break;
        this.state.deck = this.state.discard.splice(0);
        this.shuffle(this.state.deck);
      }
      const matchIndex = this.matchingDrawIndex();
      const drawnCard = matchIndex >= 0 ? this.state.deck.splice(matchIndex, 1)[0] : this.state.deck.pop();
      if (!drawnCard) break;
      this.state.hand.push(drawnCard);
      drawn += 1;
    }
    return drawn;
  }

  /**
   * 「幫玩家一把」：有 balance.matchDrawChance 的機率，刻意從牌庫挑一張
   * 能對應目前可見壓力的行動卡（優先挑手上還沒有的）。回傳牌庫位置，-1 代表照常抽最上面那張。
   */
  matchingDrawIndex() {
    const chance = this.content.balance.matchDrawChance;
    if (chance <= 0 || this.random() >= chance) return -1;
    const visibleHazardIds = new Set(
      this.state.employees.flatMap((employee) =>
        employee.pressures.filter((pressure) => !pressure.hidden).map((pressure) => pressure.hazardId),
      ),
    );
    if (visibleHazardIds.size === 0) return -1;
    const matchingIndexes = this.state.deck.flatMap((deckCard, index) => {
      const definition = this.content.cards.find((candidate) => candidate.id === deckCard.definitionId);
      return definition?.kind === "action" && definition.hazardId && visibleHazardIds.has(definition.hazardId)
        ? [index]
        : [];
    });
    if (matchingIndexes.length === 0) return -1;
    const handDefinitionIds = new Set(this.state.hand.map((handCard) => handCard.definitionId));
    const freshIndexes = matchingIndexes.filter(
      (index) => !handDefinitionIds.has(this.state.deck[index].definitionId),
    );
    const candidates = freshIndexes.length > 0 ? freshIndexes : matchingIndexes;
    return candidates[Math.floor(this.random() * candidates.length)];
  }

  /**
   * 取得員工的設定資料（employees.json 裡那一筆）。
   */
  getDefinition(employee) {
    const definition = this.content.employees.find((candidate) => candidate.id === employee.definitionId);
    if (!definition) throw new Error(`未知員工：${employee.definitionId}`);
    return definition;
  }

  /**
   * 員工頭上對話泡泡要說的話：
   * 剛被處理的壓力 → 感謝；有可見壓力 → 心情低落時的台詞，或員工專屬台詞，或一般台詞；
   * 只有隱藏壓力 → 欲言又止；沒有壓力 → 道謝。
   */
  speechFor(employee) {
    const resolvedHazardId = employee.resolvedHazardIds[0];
    if (resolvedHazardId) return this.hazardBubbles(resolvedHazardId).resolved;
    const visiblePressure = employee.pressures.filter((pressure) => !pressure.hidden)[0];
    if (!visiblePressure)
      return employee.pressures.length > 0 ? "有件事……我還不知道怎麼說。" : "謝謝你，我現在好多了！";
    const bubbles = this.hazardBubbles(visiblePressure.hazardId);
    return employee.mood <= 2
      ? bubbles.lowMood
      : (this.content.bubbles.employees.find(
          (bubble) =>
            bubble.employeeId === employee.definitionId &&
            bubble.hazardId === visiblePressure.hazardId &&
            visiblePressure.createdRound === this.state.round,
        )?.text ?? bubbles.initial);
  }

  /**
   * 取得某種風險的泡泡台詞（bubbles.json）。
   */
  hazardBubbles(hazardId) {
    const bubbles = this.content.bubbles.hazards.find((entry) => entry.hazardId === hazardId);
    if (!bubbles) throw new Error(`風險 ${hazardId} 缺少泡泡文字。`);
    return bubbles;
  }

  /**
   * 依本回合設定的人數補員工（扣掉已離職人數；離職過的人不會再出現）。
   */
  fillEmployees() {
    const targetCount = Math.max(0, this.roundBalance().employeeCount - this.state.resigned);
    const presentIds = new Set(this.state.employees.map((employee) => employee.definitionId));
    for (const definitionId of this.employeeOrder) {
      if (this.state.employees.length >= targetCount) break;
      const definition = this.content.employees.find((candidate) => candidate.id === definitionId);
      if (!(presentIds.has(definition.id) || this.departedDefinitions.has(definition.id))) {
        this.state.employees.push({
          instanceId: this.nextInstanceId++,
          definitionId: definition.id,
          mood: this.content.balance.startingMood,
          traitRevealed: false,
          pressures: [],
          effects: [],
          resolvedHazardIds: [],
        });
        this.appearedDefinitions.push(definition.id);
      }
    }
  }

  /**
   * 本局出現過的員工「名字/特質」清單（試玩紀錄用）。
   */
  roster() {
    return this.appearedDefinitions
      .map((definitionId) => {
        const definition = this.content.employees.find((candidate) => candidate.id === definitionId);
        return `${definition.name}/${definition.traitName}`;
      })
      .join(";");
  }

  /**
   * 結算畫面用：每位出現過的員工最後的心情、是否離職。
   */
  moodRoster() {
    const moodById = new Map(this.state.employees.map((employee) => [employee.definitionId, employee.mood]));
    return this.appearedDefinitions.map((definitionId) => {
      const mood = moodById.get(definitionId);
      return {
        definitionId,
        mood: mood ?? 0,
        departed: mood === undefined,
      };
    });
  }

  /**
   * 每回合開始時，為每位員工加上新壓力：
   * - 總點數在本回合的 pressureMin～pressureMax 之間隨機，分配到最多 2 種風險
   * - 優先給新的風險種類（每人最多累積 3 種），點數隨機分配
   * - 員工對某些風險 / 面向特別敏感時，那一項會多分到 1 點（不超過上限）
   * - 還沒被傾聽的員工：第一項壓力會隱藏；有 hidePressuresUntilListened 特質的則全部隱藏
   * - 每項壓力不超過 balance.hazardPointCap，且總點數不超過 pressureMax
   */
  addRoundPressures() {
    const balance = this.roundBalance();
    for (const employee of this.state.employees) {
      const totalPoints = this.integer(balance.pressureMin, balance.pressureMax);
      const hazardCount = Math.min(2, totalPoints);
      const existingHazardIds = new Set(employee.pressures.map((pressure) => pressure.hazardId));
      const existingHazards = this.content.hazards.filter((hazard) => existingHazardIds.has(hazard.id));
      const newHazards = this.content.hazards.filter((hazard) => !existingHazardIds.has(hazard.id));
      this.shuffle(existingHazards);
      this.shuffle(newHazards);
      const newSlots = Math.max(0, 3 - existingHazardIds.size);
      const chosenHazards = [
        ...newHazards.slice(0, Math.min(hazardCount, newSlots)),
        ...existingHazards.slice(0, Math.max(0, hazardCount - newSlots)),
      ];
      this.shuffle(chosenHazards);
      const pointsPerHazard = chosenHazards.map(() => 1);
      for (let i = pointsPerHazard.length; i < totalPoints; i += 1)
        pointsPerHazard[Math.floor(this.random() * pointsPerHazard.length)] += 1;
      const definition = this.getDefinition(employee);
      const sensitiveIndex = chosenHazards.findIndex(
        (hazard) =>
          definition.sensitiveHazardIds?.includes(hazard.id) ||
          definition.sensitiveCategories?.includes(hazard.category),
      );
      const donorIndex = pointsPerHazard.findIndex((points, index) => index !== sensitiveIndex && points > 1);
      if (
        sensitiveIndex >= 0 &&
        donorIndex >= 0 &&
        pointsPerHazard[sensitiveIndex] < this.content.balance.hazardPointCap
      ) {
        pointsPerHazard[sensitiveIndex] += 1;
        pointsPerHazard[donorIndex] -= 1;
      }
      let budget = balance.pressureMax;
      chosenHazards.forEach((hazard, index) => {
        let points = pointsPerHazard[index];
        points = Math.min(points, budget);
        budget -= points;
        if (points <= 0) return;
        const existing = employee.pressures.find((pressure) => pressure.hazardId === hazard.id);
        const hidden =
          !employee.traitRevealed && (definition.hidePressuresUntilListened === true || index === 0);
        if (existing) {
          existing.points = Math.min(this.content.balance.hazardPointCap, existing.points + points);
          if (hidden) {
            existing.hidden = true;
          }
        } else {
          employee.pressures.push({
            id: this.nextPressureId++,
            hazardId: hazard.id,
            points: Math.min(this.content.balance.hazardPointCap, points),
            hidden,
            createdRound: this.state.round,
          });
        }
      });
    }
  }

  /**
   * 困難模式（features.specialEvents）在第 2、4 回合抽一個沒出現過的特殊事件，
   * 替隨機一位員工加上該風險 1 點；第 4 回合的事件另外讓本回合行動 +1。
   */
  announceSpecialEvent() {
    if (!this.featureEnabled("specialEvents") || (this.state.round !== 2 && this.state.round !== 4)) {
      this.state.activeEvent = undefined;
      return;
    }
    const occurred = new Set(this.state.occurredEventIds);
    const candidates = (this.content.events ?? []).filter(
      (event) =>
        !occurred.has(event.id) &&
        event.hazardId &&
        this.content.hazards.some((hazard) => hazard.id === event.hazardId),
    );
    if (candidates.length === 0 || this.state.employees.length === 0) {
      this.state.activeEvent = undefined;
      return;
    }
    const event = candidates[Math.floor(this.random() * candidates.length)];
    const employee = this.state.employees[Math.floor(this.random() * this.state.employees.length)];
    this.addEventPressure(employee, event.hazardId);
    const isBonusRound = this.state.round === 4;
    if (isBonusRound) {
      this.eventBonusActions = 1;
    }
    const description = event.description.replaceAll("{員工}", this.employeeName(employee));
    this.state.occurredEventIds = [...this.state.occurredEventIds, event.id];
    this.state.activeEvent = {
      ...event,
      description,
      employeeInstanceId: employee.instanceId,
      bonusActions: isBonusRound,
    };
    this.state.lastMessage = `第 ${this.state.round} 回合｜${event.name}：${description}`;
  }

  /**
   * 特殊事件造成的壓力：已有該項就 +1 點並公開，沒有就新增 1 點。
   */
  addEventPressure(employee, hazardId) {
    const existing = employee.pressures.find((pressure) => pressure.hazardId === hazardId);
    if (existing) {
      existing.points = Math.min(this.content.balance.hazardPointCap, existing.points + 1);
      existing.hidden = false;
      return;
    }
    employee.pressures.push({
      id: this.nextPressureId++,
      hazardId,
      points: 1,
      hidden: false,
      createdRound: this.state.round,
    });
  }

  /**
   * 同面向加成（features.sameCategoryCombo）：同一回合對同一位員工，
   * 第二次對症處理同一面向的壓力時，心情額外 +1。
   */
  applySameCategoryCombo(employee, category, outcome) {
    if (!this.featureEnabled("sameCategoryCombo")) return;
    let counts = this.exactCategoryCounts.get(employee.instanceId);
    if (!counts) {
      counts = new Map();
      this.exactCategoryCounts.set(employee.instanceId, counts);
    }
    const count = (counts.get(category) ?? 0) + 1;
    counts.set(category, count);
    if (count === 2) {
      employee.mood = Math.min(this.content.balance.maxMood, employee.mood + 1);
      outcome.message += " 同一面向一起處理，心情 +1。";
      this.state.lastMessage = outcome.message;
      this.state.lastCombo = true;
    }
  }

  /**
   * 某個功能開關是否開啟（features.json）。
   */
  featureEnabled(feature) {
    return this.content.features?.[feature] === true;
  }

  /**
   * 依 cards.json 每張牌的 count 建立牌庫。
   */
  createDeck() {
    return this.content.cards.flatMap((card) =>
      Array.from(
        {
          length: card.count,
        },
        () => ({
          instanceId: this.nextInstanceId++,
          definitionId: card.id,
        }),
      ),
    );
  }

  /**
   * 第一回合教學：先把第一位員工各項壓力的對症牌放進手牌，再補抽到應有張數。
   */
  drawOpeningMatches() {
    const firstEmployee = this.state.employees[0];
    if (!firstEmployee) {
      this.draw(this.drawCount());
      return;
    }
    for (const pressure of firstEmployee.pressures) {
      const card = this.content.cards.find(
        (candidate) => candidate.kind === "action" && candidate.hazardId === pressure.hazardId,
      );
      const deckIndex = this.state.deck.findIndex((deckCard) => deckCard.definitionId === card?.id);
      if (deckIndex >= 0) {
        this.state.hand.push(this.state.deck.splice(deckIndex, 1)[0]);
      }
    }
    this.draw(Math.max(0, this.drawCount() - this.state.hand.length));
  }

  /**
   * 偶數回合提供一張顧問卡（不佔手牌，放在手牌最右邊）。
   */
  createManagementTool(round) {
    if (round % 2 === 1) return;
    const consultant = this.content.cards.find((card) => card.kind === "consultant");
    if (consultant)
      return {
        instanceId: this.nextInstanceId++,
        definitionId: consultant.id,
      };
  }

  /**
   * 用掉一次行動。
   */
  consumePlay() {
    this.state.playsRemaining -= 1;
  }

  /**
   * 確認還能行動，否則丟出錯誤。
   */
  assertCanPlay() {
    this.assertActive();
    if (this.state.playsRemaining <= 0) throw new Error("本回合已用完 3 次行動。");
  }

  /**
   * 確認這局還沒結束，否則丟出錯誤。
   */
  assertActive() {
    if (this.state.phase !== "action") throw new Error("本局已經結束。");
  }

  /**
   * 用 instanceId 找在場員工；找不到時的錯誤訊息會顯示給玩家。
   */
  employee(instanceId) {
    const employee = this.state.employees.find((candidate) => candidate.instanceId === instanceId);
    if (!employee) throw new Error("請把牌拖到一位員工身上。");
    return employee;
  }

  /**
   * 員工的名字。
   */
  employeeName(employee) {
    return this.getDefinition(employee).name;
  }

  /**
   * 用 id 找卡牌設定。
   */
  card(cardId) {
    const card = this.content.cards.find((candidate) => candidate.id === cardId);
    if (!card) throw new Error(`未知卡牌：${cardId}`);
    return card;
  }

  /**
   * 用 id 找風險設定。
   */
  hazard(hazardId) {
    const hazard = this.content.hazards.find((candidate) => candidate.id === hazardId);
    if (!hazard) throw new Error(`未知風險：${hazardId ?? "未指定"}`);
    return hazard;
  }

  /**
   * 本回合適用的平衡設定（員工人數、壓力範圍）。
   */
  roundBalance() {
    const balance = this.content.balance.rounds.find(
      (range) => this.state.round >= range.from && this.state.round <= range.to,
    );
    if (!balance) throw new Error(`第 ${this.state.round} 回合缺少平衡設定。`);
    return balance;
  }

  /**
   * 依在場員工人數，從陣列取出對應的值（第 1 格是 1 人時）。
   */
  employeeScaledValue(valuesByEmployeeCount, label) {
    const value = valuesByEmployeeCount[this.state.employees.length - 1];
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${this.state.employees.length} 名員工缺少有效的${label}設定。`);
    return value;
  }

  /**
   * 結束這局。
   */
  finish(reason) {
    this.state.phase = "result";
    this.state.endReason = reason;
  }

  /**
   * 設定畫面下方的訊息，並回傳出牌結果。
   */
  message(result, text) {
    this.state.lastMessage = text;
    return {
      result,
      message: text,
    };
  }

  /**
   * min～max 之間的隨機整數（含兩端）。
   */
  integer(min, max) {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  /**
   * 洗牌（Fisher–Yates），直接修改傳入的陣列。
   */
  shuffle(items) {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }

  /**
   * 由種子產生可重現的亂數函式（回傳 0 ≤ x < 1）。
   */
  seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state += 1831565813;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }
}
