/**
 * ISO 45003 互動遊戲｜完整手機版：畫面與操作
 *
 * 遊戲規則全部在 engine/GameEngine.js（和桌面原版同一份、已驗證過的程式），這裡只負責：
 *   - 首頁、遊戲中、回合結算、結算畫面
 *   - 夥伴排隊：一位站在前面處理，其他人在後面排隊；點排隊的人可以換他上前；
 *     前面的人壓力都處理完，會自動換下一位需要幫忙的人上前
 *   - 出牌：點卡牌再點前面的夥伴，或把卡牌往上拖到夥伴身上
 *   - 音效、存檔續玩、試玩紀錄（?debug=1）、離線與自動更新
 *
 * 畫法：每次狀態改變就整個重畫（innerHTML），事件只在一開始綁定一次，
 * 所以不會有「舊按鈕殘留」或「越玩越慢」的問題。
 */
import { GameEngine } from "./engine/GameEngine.js";
import { validateContent } from "./content/validateContent.js";
import { createPlaytest, recordPlaytestPlay, advancePlaytestRound, finishPlaytest, playtestRecordsToCsv } from "./playtest/playtest.js";
import { PlaytestStore } from "./playtest/PlaytestStore.js";
import { getTesterName, isDebugMode, isE2EMode, resolveSeed } from "./config/query.js";
import { GameAudio } from "./audio.js";
import { contentFingerprint, replay, writeSave, readSave, clearSave } from "./save.js";

const app = document.querySelector("#app");
const overlay = document.querySelector("#overlay");
const query = location.search;
const E2E = isE2EMode(query);
const DEBUG = isDebugMode(query);
const wait = (ms) => (E2E ? Math.min(ms, 30) : ms); // 自動測試模式把等待時間縮短
const CATEGORY_LABELS = { workDesign: "工作設計", social: "社會因素", environment: "工作環境" };
const PREF_KEY = "iso45003-full-pref";
const MASCOTS = ["mascot-hope", "mascot-peace", "mascot-care", "mascot-nature", "mascot-energy"];

let content = null; // 遊戲資料（data/*.json）
let fingerprint = "";
let engine = null; // 目前這一局的規則（GameEngine）
let game = null; // { seed, features, steps, front, playtest }
let screen = "loading"; // cover | play | result
let selected = null; // 已選的卡："listen"（傾聽）或卡牌 instanceId
let reviewPicks = null; // 使用「檢視流程」卡時，選要換掉的牌
let notice = ""; // 暫時顯示在訊息列的提示（優先於規則的訊息）
let lastHint = null; // { employeeId, text }：選錯卡後夥伴說的提示
let feedback = null; // 剛剛出牌的結果，畫完後播動畫
let frontChanged = false;
let justSolved = false;
let pendingSwitch = null; // { to, at }：前面的夥伴處理完，準備換下一位上前
let busy = false;
let timers = [];
let sessionIndex = 0;
const audio = new GameAudio(E2E);
// 試玩紀錄另外加上前綴：同一個網域（例如同一個 GitHub 帳號）下的桌面版用同一個名稱，避免兩邊紀錄混在一起
const store = new PlaytestStore(prefixedStorage("iso45003-full:"));

// ════════ 小工具 ════════
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cardDef = (inst) => content.cards.find((c) => c.id === inst.definitionId);
const hazardOf = (id) => content.hazards.find((h) => h.id === id);
const employeeDef = (emp) => content.employees.find((e) => e.id === (emp.definitionId ?? emp));
const portrait = (def, cls = "portrait") =>
  `<img class="${cls}" src="assets/characters/${esc(def.asset ?? "mascot-hope")}.webp" alt="${esc(def.name)}" draggable="false">`;
const hearts = (mood) => {
  const max = content.balance.maxMood;
  return `<span class="hearts${mood <= 2 ? " low" : ""}" aria-label="心情 ${mood} / ${max}">${"♥".repeat(Math.max(0, mood))}<i>${"♡".repeat(Math.max(0, max - mood))}</i></span>`;
};
function later(fn, ms) {
  timers.push(setTimeout(fn, wait(ms)));
}
function clearTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}
function safeStorage() {
  try {
    localStorage.setItem("__t", "1");
    localStorage.removeItem("__t");
    return localStorage;
  } catch {
    const mem = new Map();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  }
}
function prefixedStorage(prefix) {
  const base = safeStorage();
  return {
    getItem: (k) => base.getItem(prefix + k),
    setItem: (k, v) => base.setItem(prefix + k, v),
    removeItem: (k) => base.removeItem(prefix + k),
  };
}
function readPref() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
  } catch {
    return {};
  }
}
function writePref(pref) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    /* 略過 */
  }
}
/** 新的一局要用的功能開關：難度（特殊事件）與除錯面板的設定，記在這台裝置上。 */
function currentFeatures() {
  const pref = readPref();
  return {
    ...content.features,
    specialEvents: typeof pref.hard === "boolean" ? pref.hard : content.features.specialEvents === true,
    sameCategoryCombo: typeof pref.combo === "boolean" ? pref.combo : content.features.sameCategoryCombo === true,
  };
}
function scrollTop() {
  window.scrollTo({ top: 0, behavior: "instant" });
}

// ════════ 確認視窗 ════════
let sheetResolve = null;
/** 從下方滑出的對話框；回傳被按下的按鈕代號（關閉則為 null）。 */
function sheet(html, buttons) {
  if (sheetResolve) sheetResolve(null);
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}<div class="sheet-actions">${buttons
    .map((b) => `<button class="${b.primary ? "primary" : "secondary"}" data-sheet="${esc(b.key)}">${esc(b.label)}</button>`)
    .join("")}</div></div>`;
  overlay.hidden = false;
  document.body.classList.add("sheet-open");
  overlay.querySelector(".primary, .secondary")?.focus({ preventScroll: true });
  return new Promise((resolve) => {
    sheetResolve = resolve;
  });
}
function closeSheet(result) {
  overlay.hidden = true;
  overlay.innerHTML = "";
  document.body.classList.remove("sheet-open");
  const resolve = sheetResolve;
  sheetResolve = null;
  resolve?.(result);
}

// ════════ 首頁 ════════
function renderCover() {
  clearTimers();
  screen = "cover";
  engine = null;
  game = null;
  selected = null;
  reviewPicks = null;
  const save = readSave(fingerprint);
  const hard = currentFeatures().specialEvents;
  const rounds = content.balance.totalRounds;
  app.innerHTML = `
    <section class="hero cover">
      <div class="eyebrow">ISO 45003 互動遊戲</div>
      <h1>一起打造安心工作的每一天</h1>
      <div class="cast">${["mascot-care", "mascot-hope", "mascot-energy"].map((a) => portrait(content.employees.find((e) => e.asset === a) ?? { asset: a, name: "" })).join("")}</div>
      <p class="cover-slogan">先聽懂壓力，再選擇真正對症的行動</p>
    </section>
    <div class="difficulty" role="radiogroup" aria-label="難度">
      <button role="radio" aria-checked="${!hard}" data-action="difficulty" data-hard="0">簡單</button>
      <button role="radio" aria-checked="${hard}" data-action="difficulty" data-hard="1">困難</button>
    </div>
    <p class="difficulty-note">${hard ? "第 2、4 回合會出現突發事件" : "一般壓力，沒有突發事件"}</p>
    <button class="primary start-button" data-action="start">開始照顧團隊</button>
    ${save ? '<button class="secondary resume" data-action="resume">繼續上次的進度</button>' : ""}
    <p class="intro-note small">共 ${rounds} 回合・約 3 分鐘<br>點卡牌再點夥伴，也可以把卡牌拖到夥伴身上</p>
    ${DEBUG ? debugPanel() : ""}`;
  applyUpdateIfIdle();
  requestUpdateCheck();
}

function debugPanel() {
  const f = currentFeatures();
  const count = store.load().length;
  return `<section class="panel debug">
    <h3>試玩設定（除錯模式）</h3>
    <button class="secondary" data-action="toggle-feature" data-feature="specialEvents">特殊事件｜${f.specialEvents ? "開" : "關"}</button>
    <button class="secondary" data-action="toggle-feature" data-feature="sameCategoryCombo">同面向加成｜${f.sameCategoryCombo ? "開" : "關"}</button>
    <p class="small">這台裝置已有 ${count} 筆試玩紀錄</p>
    <button class="secondary" data-action="export-csv">匯出 CSV</button>
    <button class="secondary" data-action="clear-records">清除紀錄</button>
  </section>`;
}

// ════════ 開局、續玩 ════════
/** 有未完成的舊局時，先把它記成「未完成」的試玩紀錄。 */
function commitAbandoned() {
  const save = readSave(fingerprint);
  if (save?.playtest && !save.playtest.saved) {
    const old = replay(content, save);
    if (old) store.append(finishPlaytest(save.playtest, playtestSummary(old, save.playtest, "未完成")));
  }
  clearSave();
}

function startGame() {
  commitAbandoned();
  const features = currentFeatures();
  engine = new GameEngine({ ...content, features }, resolveSeed(query, sessionIndex));
  sessionIndex += 1;
  game = {
    seed: engine.seed,
    features,
    steps: [],
    front: null,
    playtest: createPlaytest({
      tester: getTesterName(query),
      seed: engine.seed,
      specialEvents: features.specialEvents,
      sameCategoryCombo: features.sameCategoryCombo,
    }),
  };
  resetTurnState();
  pickFront();
  persist();
  audio.startMusic();
  renderPlay();
  scrollTop();
}

function resumeGame() {
  const save = readSave(fingerprint);
  const restored = save && replay(content, save);
  if (!restored) {
    clearSave();
    renderCover();
    return;
  }
  engine = restored;
  game = { seed: save.seed, features: save.features, steps: save.steps, front: save.front, playtest: save.playtest };
  resetTurnState();
  pickFront();
  audio.startMusic();
  if (engine.state.phase === "result") renderResult();
  else renderPlay();
  scrollTop();
}

function resetTurnState() {
  pendingSwitch = null;
  selected = null;
  reviewPicks = null;
  notice = "";
  lastHint = null;
  feedback = null;
  frontChanged = true;
  justSolved = false;
  busy = false;
}

function persist() {
  if (!engine || !game) return;
  writeSave({ fingerprint, seed: game.seed, features: game.features, steps: game.steps, front: game.front, playtest: game.playtest });
}

/** 決定誰站在前面：原本的人還在就不換；否則選第一位有壓力的人。 */
function pickFront() {
  const list = engine.state.employees;
  if (list.some((e) => e.instanceId === game.front)) return;
  game.front = (list.find((e) => e.pressures.length > 0) ?? list[0])?.instanceId ?? null;
  frontChanged = true;
}
const frontEmployee = () => engine.state.employees.find((e) => e.instanceId === game.front);

// ════════ 遊戲中畫面 ════════
function renderPlay() {
  clearTimers();
  screen = "play";
  const st = engine.state;
  if (st.phase === "result") {
    renderResult();
    return;
  }
  advancePlaytestRound(game.playtest, st.round);
  pickFront();
  const front = frontEmployee();
  const others = st.employees.filter((e) => e !== front);
  const total = content.balance.totalRounds;
  const actionsLeft = st.playsRemaining;
  const pips = Array.from({ length: engine.actionLimit() }, (_, i) => `<i class="${i < actionsLeft ? "on" : ""}"></i>`).join("");
  const event = st.activeEvent;
  const handScroll = app.querySelector(".hand")?.scrollLeft ?? 0;
  app.innerHTML = `
    <div class="play">
      <header class="topbar">
        <div class="round-info">
          <strong>第 ${st.round} / ${total} 回合</strong>
          <span class="pips" aria-label="本回合還有 ${actionsLeft} 次行動">${pips}<small>行動 ${actionsLeft}</small></span>
        </div>
        <div class="tools">
          <button data-action="mute">${audio.muted ? "已靜音" : "音樂開"}</button>
          <button data-action="volume">${audio.volumeLabel}</button>
          <button data-action="leave">離開</button>
        </div>
      </header>
      ${event ? `<div class="event-banner" role="status"><strong>突發事件｜${esc(event.name)}${event.bonusActions ? "（本回合行動 +1）" : ""}</strong><span>${esc(event.description)}</span></div>` : ""}
      <section class="panel stage">${front ? stageHTML(front, others) : "<p>本回合沒有夥伴在場。</p>"}</section>
      <section class="tray" aria-label="手牌">${trayHTML(front)}</section>
    </div>`;
  const hand = app.querySelector(".hand");
  if (hand) {
    hand.scrollLeft = handScroll;
    const picked = hand.querySelector('[aria-pressed="true"]');
    if (picked) {
      const left = picked.offsetLeft - hand.offsetLeft;
      if (left < hand.scrollLeft) hand.scrollLeft = left - 8;
      else if (left + picked.offsetWidth > hand.scrollLeft + hand.clientWidth) hand.scrollLeft = left + picked.offsetWidth - hand.clientWidth + 8;
    }
  }
  if (selected !== null) keepFrontVisible();
  afterPlayRender(front, others);
}

/** 選了卡之後，確保前面的夥伴沒有被下方的手牌區蓋住（小手機上手牌區比較高）。 */
function keepFrontVisible() {
  if (document.body.classList.contains("wide")) return;
  const target = app.querySelector(".front");
  const tray = app.querySelector(".tray");
  if (!target || !tray) return;
  const t = target.getBoundingClientRect();
  const limit = tray.getBoundingClientRect().top - 8;
  if (t.bottom > limit) window.scrollBy({ top: t.bottom - limit, behavior: "instant" });
  else if (t.top < 0) window.scrollBy({ top: t.top - 8, behavior: "instant" });
}

function messageText(front) {
  if (notice) return notice;
  const st = engine.state;
  if (front && st.playsRemaining > 0 && st.employees.every((e) => e.pressures.length === 0))
    return "大家的壓力都處理好了！可以按「結算本回合」。";
  if (st.playsRemaining <= 0) return `${st.lastMessage}　本回合行動已用完，請按「結算本回合」。`;
  return st.lastMessage;
}

function stageHTML(front, others) {
  const def = employeeDef(front);
  const speech = lastHint?.employeeId === front.instanceId ? lastHint.text : engine.speechFor(front);
  const waiting = others
    .map((e, i) => {
      const d = employeeDef(e);
      const status = e.pressures.length === 0 ? "✓ 沒事了" : e.pressures.some((p) => p.hidden) ? "有心事" : `壓力 ${e.pressures.reduce((a, p) => a + p.points, 0)} 點`;
      return `<button class="waiting-person${e.mood <= 2 ? " worried" : ""}" style="--queue-index:${i}" data-action="switch" data-employee="${e.instanceId}" aria-label="換${esc(d.name)}上前（心情 ${e.mood}，${status}）">
        ${portrait(d)}<span>${esc(d.name)}</span>${hearts(e.mood)}<small>${status}</small></button>`;
    })
    .join("");
  const notes = front.pressures.length
    ? front.pressures
        .map((p) => {
          const h = hazardOf(p.hazardId);
          return p.hidden
            ? `<li class="note hidden-note"><span>尚未說出的壓力</span><b>${p.points} 點</b></li>`
            : `<li class="note cat-${esc(h.category)}"><img src="assets/icons/${esc(h.id)}.svg" alt=""><span>${esc(h.name)}</span><b>${p.points} 點</b></li>`;
        })
        .join("")
    : '<li class="note done-note">✓ 壓力都處理好了</li>';
  const prevention = preventionList(front);
  const trait = front.traitRevealed
    ? `<p class="trait-detail"><strong>${esc(def.traitName)}</strong>｜${esc(def.traitEffect)}<br><span>${esc(def.traitDescription)}</span></p>`
    : '<p class="trait-detail muted">傾聽後可以了解個人特質</p>';
  return `
    <div class="queue-stage${others.length ? "" : " alone"}">
      ${others.length ? `<div class="waiting-line" aria-label="排隊中的夥伴（點一下可換他上前）">${waiting}</div><p class="queue-tip small">點後面的夥伴，可以換他上前</p>` : ""}
      <div class="front${frontChanged ? " entering" : ""}${selected !== null ? " ready" : ""}" data-drop-target data-employee="${front.instanceId}" role="button" tabindex="0"
           aria-label="${selected !== null ? `把選好的卡交給${esc(def.name)}` : esc(def.name)}">
        <span class="character-art${front.mood <= 2 ? " shiver" : ""}">${portrait(def)}</span>
        <span class="who">
          <strong class="character-name" style="--name-color:${esc(def.color)}">${esc(def.name)}</strong>
          ${hearts(front.mood)}
          <span class="trait">${front.traitRevealed ? esc(def.traitName) : "個人特質：未知"}</span>
        </span>
        <span class="drop-badge" aria-hidden="true">＋</span>
      </div>
    </div>
    <p class="quote speech-bubble">${esc(speech)}</p>
    <h3 class="notes-title">壓力便條</h3>
    <ul class="notes">${notes}</ul>
    ${prevention}
    ${trait}`;
}

/** 長期措施：依風險整理成一行一行（疊幾層、還剩幾回合、是否下回合才生效）。 */
function preventionList(emp) {
  if (!emp.effects.length) return "";
  const byHazard = new Map();
  for (const ef of emp.effects) {
    const pending = ef.activatedRound >= engine.state.round;
    const cur = byHazard.get(ef.hazardId);
    if (!cur) byHazard.set(ef.hazardId, { layers: 1, remaining: ef.remaining, pending });
    else {
      cur.layers += 1;
      cur.remaining = Math.max(cur.remaining, ef.remaining);
      cur.pending = cur.pending && pending;
    }
  }
  const rows = [...byHazard]
    .map(([id, info]) => {
      const name = hazardOf(id)?.name ?? "未知風險";
      const when = info.pending ? `下回合起・${info.remaining} 回合` : `還剩 ${info.remaining} 回合`;
      return `<li>🛡 ${esc(name)}｜每回合預防 ${info.layers} 點・${when}</li>`;
    })
    .join("");
  return `<ul class="prevention" aria-label="長期措施">${rows}</ul>`;
}

/** 手牌排序：傾聽 → 工作設計 → 社會因素 → 工作環境 → 輔導 → 其他 → 顧問（管理工具）。 */
function handItems() {
  const st = engine.state;
  const rank = (inst) => {
    const d = cardDef(inst);
    if (d.kind === "counseling") return 40;
    if (d.kind !== "action" || !d.hazardId) return 50;
    const cat = hazardOf(d.hazardId)?.category;
    return cat === "workDesign" ? 10 : cat === "social" ? 20 : 30;
  };
  const sorted = [...st.hand].sort((a, b) => rank(a) - rank(b));
  return [...(st.listeningAvailable ? ["listen"] : []), ...sorted, ...(st.managementTool ? [st.managementTool] : [])];
}

function trayHTML(front) {
  const st = engine.state;
  const items = handItems();
  const noActions = st.playsRemaining <= 0;
  const hasHidden = st.employees.some((e) => e.pressures.some((p) => p.hidden));
  const cards = items
    .map((item) => {
      const isListen = item === "listen";
      const id = isListen ? "listen" : item.instanceId;
      const d = isListen ? null : cardDef(item);
      const hz = d?.hazardId ? hazardOf(d.hazardId) : null;
      const isTool = !isListen && st.managementTool?.instanceId === item.instanceId;
      const kindClass = isListen ? "kind-listen" : hz ? `cat-${hz.category}` : `kind-${d.kind}`;
      const label = isListen ? "先了解原因" : hz ? CATEGORY_LABELS[hz.category] : isTool ? "管理工具" : d.kind === "counseling" ? "支持" : "管理輔助";
      const icon = isListen ? "listen" : (hz?.id ?? (d.kind === "consultant" ? "consultant" : d.kind === "counseling" ? "counseling" : "reroll"));
      const name = isListen ? "傾聽" : d.name;
      const matching =
        d?.kind === "action" && st.employees.some((e) => e.pressures.some((p) => !p.hidden && p.hazardId === d.hazardId));
      const tutorial = st.round === 1 ? (isListen && hasHidden ? "步驟 1｜先傾聽" : !hasHidden && matching ? "對症牌" : "") : "";
      const picked = reviewPicks?.has(id);
      return `<button class="card ${kindClass}${noActions ? " spent" : ""}${picked ? " picked" : ""}" data-card="${id}"
        aria-pressed="${selected === id || picked ? "true" : "false"}" aria-label="${esc(name)}（${esc(label)}）">
        ${tutorial ? `<span class="tutorial">${tutorial}</span>` : ""}
        <span class="card-band">${esc(label)}</span>
        <img src="assets/icons/${esc(icon)}.svg" alt="" draggable="false">
        <strong>${esc(name)}</strong>
        ${d?.longTerm ? '<span class="card-tag">長期措施</span>' : ""}
      </button>`;
    })
    .join("");
  const rerollLabel = st.round === 1 ? "教學後開放" : st.rerollAvailable ? "整手換牌" : "本回合已換牌";
  return `
    ${selected === null && !reviewPicks
      ? `<p class="message" role="status">${esc(messageText(front))}</p>`
      : `<p class="card-detail" id="card-detail">${detailHTML()}</p>`}
    <div class="hand${st.round === 1 ? " has-tutorial" : ""}">${cards || '<p class="empty-hand">手牌用完了</p>'}</div>
    <div class="tray-actions">
      <button class="secondary${st.rerollAvailable ? "" : " dim"}" data-action="reroll">${rerollLabel}</button>
      <button class="primary" data-action="end">結算本回合 ✓</button>
    </div>`;
}

/** 手牌上方的說明：選了哪張牌、這張牌的效果。 */
function detailHTML() {
  const st = engine.state;
  if (reviewPicks) {
    return `選最多 3 張要換掉的牌（已選 ${reviewPicks.size} 張）
      <span class="detail-actions"><button class="mini primary" data-action="review-confirm">確定更換</button><button class="mini secondary" data-action="review-cancel">取消</button></span>`;
  }
  if (selected === null) {
    return st.playsRemaining > 0 ? "點卡牌看說明，再點前面的夥伴使用；也可以把卡牌往上拖到夥伴身上。" : "本回合行動已用完。";
  }
  if (selected === "listen") return "<strong>傾聽</strong>：揭露這位夥伴所有的壓力與個人特質，之後的壓力也會保持公開，心情 +1。每回合一次。";
  const inst = findCard(selected);
  if (!inst) return "";
  const d = cardDef(inst);
  const dur = content.balance.longTermDuration;
  if (d.kind === "action") {
    return `<strong>${esc(d.name)}</strong>：${esc(d.description)}。<br>對症：清除這項壓力${d.longTerm ? `、心情 +1，並從下回合起每回合預防 1 點，持續 ${dur} 回合` : ""}；同類：降低 1 點；無關：心情 +1。`;
  }
  if (d.kind === "consultant")
    return `<strong>${esc(d.name)}</strong>：${esc(d.description)}，不需要指定夥伴。<span class="detail-actions"><button class="mini primary" data-action="use-tool">直接使用</button></span>`;
  if (d.kind === "review") return `<strong>${esc(d.name)}</strong>：${esc(d.description)}。點一下夥伴後，選要換掉的牌。`;
  return `<strong>${esc(d.name)}</strong>：${esc(d.description)}。`;
}

function findCard(id) {
  const st = engine.state;
  return st.hand.find((c) => c.instanceId === id) ?? (st.managementTool?.instanceId === id ? st.managementTool : null);
}

/** 畫完之後：出牌動畫、自動換下一位夥伴。 */
function afterPlayRender(front, others) {
  const shown = feedback;
  feedback = null;
  if (frontChanged && !E2E) document.querySelector(".stage")?.scrollIntoView({ block: "nearest" });
  frontChanged = false;
  if (shown) playFeedback(shown);
  if (justSolved && front && front.pressures.length === 0 && engine.state.playsRemaining > 0) {
    const next = others.find((e) => e.pressures.length > 0);
    if (next) pendingSwitch = { to: next.instanceId, at: Date.now() };
  }
  justSolved = false;
  if (pendingSwitch) {
    const name = front ? employeeDef(front).name : "";
    const msg = app.querySelector(".message");
    if (msg) msg.textContent = `${name}的壓力都處理好了，換下一位夥伴上前…`;
    const left = Math.max(0, 1500 - (Date.now() - pendingSwitch.at));
    later(() => app.querySelector(".front")?.classList.add("leaving"), Math.max(0, left - 600));
    later(() => {
      applyPendingSwitch();
      renderPlay();
    }, left);
  }
}

/** 執行「換下一位上前」。玩家在等待期間有任何操作，就立刻換，讓操作對象一定是下一位。 */
function applyPendingSwitch() {
  if (!pendingSwitch) return false;
  const to = pendingSwitch.to;
  pendingSwitch = null;
  if (engine?.state.employees.some((e) => e.instanceId === to)) {
    game.front = to;
    frontChanged = true;
    persist();
    return true;
  }
  return false;
}

function playFeedback({ outcome }) {
  const r = outcome.result;
  const text =
    { exact: "對症！", category: "方向接近", unrelated: "有關心，但沒處理根源", listening: "聽見真正原因", counseling: "獲得支持", consultant: "顧問帶來新觀點", review: "換牌完成" }[r] ?? "行動完成";
  audio.play(r === "exact" ? "exact" : r === "unrelated" ? "unrelated" : r === "category" ? "category" : "play");
  const stage = app.querySelector(".stage");
  if (!stage) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${r}`;
  toast.textContent = engine.state.lastCombo ? `${text}　同面向一起處理` : text;
  toast.setAttribute("aria-hidden", "true");
  stage.append(toast);
  const art = stage.querySelector(".front .character-art");
  art?.classList.add(r === "unrelated" ? "shake" : "hop");
  later(() => toast.remove(), 1300);
}

// ════════ 出牌 ════════
function selectCard(id) {
  applyPendingSwitch();
  if (reviewPicks) {
    if (id === "listen" || id === selected) return;
    if (reviewPicks.has(id)) reviewPicks.delete(id);
    else if (reviewPicks.size < 3) reviewPicks.add(id);
    renderPlay();
    return;
  }
  if (engine.state.playsRemaining <= 0) {
    notice = "本回合行動已用完，請按「結算本回合」。";
    selected = null;
    renderPlay();
    return;
  }
  selected = selected === id ? null : id;
  notice = "";
  audio.play("button");
  renderPlay();
}

/** 把選好的卡用在夥伴身上（consultant 不需要夥伴）。 */
function useSelected(employeeId) {
  if (selected === null || !engine || engine.state.phase !== "action" || busy) return;
  if (engine.state.playsRemaining <= 0) {
    notice = "本回合行動已用完，請按「結算本回合」。";
    selected = null;
    renderPlay();
    return;
  }
  const sel = selected;
  if (sel !== "listen" && cardDef(findCard(sel) ?? {})?.kind === "review") {
    reviewPicks = new Set();
    renderPlay();
    return;
  }
  selected = null;
  notice = "";
  lastHint = null;
  try {
    let outcome;
    if (sel === "listen") {
      outcome = engine.listen(employeeId);
      game.steps.push({ t: "listen", e: employeeId });
    } else {
      outcome = engine.playCard(sel, employeeId);
      game.steps.push({ t: "play", c: sel, e: employeeId });
    }
    afterAction(outcome, employeeId);
  } catch (error) {
    notice = error instanceof Error ? error.message : "目前無法使用這張牌。";
    audio.play("unrelated");
    renderPlay();
  }
}

function confirmReview() {
  const reviewId = selected;
  const ids = [...reviewPicks];
  reviewPicks = null;
  selected = null;
  try {
    const outcome = engine.playReview(reviewId, ids);
    game.steps.push({ t: "review", c: reviewId, ids });
    afterAction(outcome, undefined);
  } catch (error) {
    notice = error.message;
    renderPlay();
  }
}

function afterAction(outcome, employeeId) {
  if (["exact", "category", "unrelated"].includes(outcome.result) && outcome.cardId) {
    recordPlaytestPlay(game.playtest, { cardId: outcome.cardId, targetHazardId: outcome.targetHazardId ?? "", result: outcome.result });
  }
  if (outcome.result === "unrelated" || outcome.result === "category") {
    const emp = engine.state.employees.find((e) => e.instanceId === employeeId);
    const top = emp?.pressures.find((p) => !p.hidden)?.hazardId;
    const hint = content.bubbles.hazards.find((b) => b.hazardId === top)?.hint;
    if (hint) lastHint = { employeeId, text: hint };
  }
  if (employeeId !== undefined && employeeId !== game.front && engine.state.employees.some((e) => e.instanceId === employeeId)) {
    game.front = employeeId;
    frontChanged = true;
  }
  const front = frontEmployee();
  justSolved = !!front && employeeId === game.front && front.pressures.length === 0;
  feedback = { outcome };
  persist();
  renderPlay();
}

function reroll() {
  const st = engine.state;
  if (!st.rerollAvailable) {
    notice = st.round === 1 ? "完成第一回合教學後，才能整手換牌。" : "本回合已經換過手牌了。";
    renderPlay();
    return;
  }
  try {
    const outcome = engine.rerollHand();
    game.steps.push({ t: "reroll" });
    selected = null;
    notice = "";
    feedback = { outcome };
    persist();
    renderPlay();
  } catch (error) {
    notice = error.message;
    renderPlay();
  }
}

// ════════ 回合結算 ════════
async function endRound() {
  if (busy) return;
  const st = engine.state;
  if (st.playsRemaining > 0 && !E2E) {
    const ok = await sheet(`<h2>確定要結算本回合嗎？</h2><p>還有 ${st.playsRemaining} 次行動沒有用。結算時，剩下的壓力會讓夥伴的心情下降。</p>`, [
      { key: "cancel", label: "繼續行動" },
      { key: "ok", label: "結算本回合", primary: true },
    ]);
    if (ok !== "ok") return;
  }
  busy = true;
  pendingSwitch = null;
  const round = st.round;
  const before = st.employees.map((e) => ({ id: e.instanceId, def: employeeDef(e), mood: e.mood, pressure: e.pressures.reduce((a, p) => a + p.points, 0) }));
  try {
    engine.endRound();
  } catch (error) {
    busy = false;
    notice = error.message;
    renderPlay();
    return;
  }
  game.steps.push({ t: "end" });
  selected = null;
  reviewPicks = null;
  notice = "";
  lastHint = null;
  persist();
  const after = engine.state;
  const departed = new Map(after.lastDepartures.map((d) => [d.instanceId, d]));
  const prevented = new Map();
  for (const p of after.lastPreventions) prevented.set(p.employeeInstanceId, (prevented.get(p.employeeInstanceId) ?? 0) + p.points);
  const rows = before
    .map((b) => {
      const now = after.employees.find((e) => e.instanceId === b.id);
      const prev = prevented.get(b.id);
      const prevText = prev ? `長期措施預防了 ${prev} 點。` : "";
      if (departed.has(b.id)) {
        const names = departed
          .get(b.id)
          .unresolvedHazardIds.slice(0, 2)
          .map((id) => hazardOf(id)?.name)
          .filter(Boolean)
          .join("、");
        return `<li class="sum-row gone">${portrait(b.def, "mini-portrait")}<span><strong>${esc(b.def.name)}離開了團隊</strong>${prevText}${names ? `持續未處理：${esc(names)}` : "累積的壓力沒有及時被處理。"}</span></li>`;
      }
      const delta = now.mood - b.mood;
      const text = delta > 0 ? `沒有壓力，心情 +${delta}` : delta < 0 ? `剩下的壓力讓心情 −${-delta}` : "心情不變";
      return `<li class="sum-row${delta < 0 ? " down" : delta > 0 ? " up" : ""}">${portrait(b.def, "mini-portrait")}<span><strong>${esc(b.def.name)}</strong>${prevText}${text}${hearts(now.mood)}</span></li>`;
    })
    .join("");
  audio.play(departed.size ? "resign" : before.some((b) => (after.employees.find((e) => e.instanceId === b.id)?.mood ?? 0) < b.mood) ? "unrelated" : "play");
  const finished = after.phase === "result";
  if (!finished) {
    frontChanged = true;
    pickFront();
    renderPlay();
  }
  const choice = await sheet(`<h2>第 ${round} 回合結算</h2><ul class="summary-list">${rows}</ul>${departed.size ? '<p class="small">下一回合，先傾聽並處理最迫切的壓力。</p>' : ""}`, [
    { key: "next", label: finished ? "看看這一局的結果" : `開始第 ${after.round} 回合 →`, primary: true },
  ]);
  void choice;
  busy = false;
  if (finished) {
    renderResult();
    scrollTop();
    return;
  }
  if (after.activeEvent) {
    audio.play("play");
    await sheet(
      `<div class="event-sheet"><p class="eyebrow">本回合突發事件</p><h2>${esc(after.activeEvent.name)}</h2><p>${esc(after.activeEvent.description)}</p>${after.activeEvent.bonusActions ? "<p><strong>本回合行動 +1</strong></p>" : ""}</div>`,
      [{ key: "go", label: "開始本回合", primary: true }],
    );
  }
  frontChanged = true;
  renderPlay();
  scrollTop();
}

// ════════ 結算畫面 ════════
function playtestSummary(e, playtest, result) {
  const st = e.state;
  return {
    result,
    endedRound: st.phase === "result" ? st.completedRounds : st.round,
    retained: st.employees.length,
    resigned: st.resigned,
    listening: st.metrics.listening,
    exact: st.metrics.exact,
    category: st.metrics.category,
    unrelated: st.metrics.unrelated,
    longTerm: st.metrics.longTerm,
    rerolls: st.metrics.rerolls,
    roster: e.roster(),
    eventIds: st.occurredEventIds,
    plays: playtest.plays,
  };
}

function renderResult() {
  clearTimers();
  screen = "result";
  const st = engine.state;
  const completed = st.endReason === "completed";
  if (game.playtest && !game.playtest.saved) {
    store.append(finishPlaytest(game.playtest, playtestSummary(engine, game.playtest, completed ? "通關" : "失敗")));
  }
  clearSave();
  audio.stopMusic();
  audio.play(completed ? "win" : "lose");
  const total = content.balance.totalRounds;
  const rating = engine.retentionRating();
  const m = st.metrics;
  const plays = m.exact + m.category + m.unrelated;
  const exactRate = plays ? Math.round((m.exact / plays) * 100) : 0;
  const avgMood = st.employees.length ? st.employees.reduce((a, e) => a + e.mood, 0) / st.employees.length : 0;
  const title =
    m.longTerm >= 3 && exactRate >= 60 ? "預防大師" : m.counseling + m.unrelated > m.exact ? "暖心老闆" : m.longTerm < 2 ? "救火隊長" : "風險偵探";
  const benefits = [
    ["員工福祉與滿意度", avgMood >= 4],
    ["降低營運成本", st.resigned === 0],
    ["生產力與創新", st.completedRounds >= total],
    ["風險治理意識", Object.values(m.exactByCategory).every((n) => n >= 2)],
    ["企業形象", m.longTerm >= 3],
  ];
  const roster = [...engine.moodRoster()].sort((a, b) => (b.mood !== a.mood ? b.mood - a.mood : a.definitionId.localeCompare(b.definitionId)));
  const topMood = Math.max(0, ...roster.map((r) => r.mood));
  const singleTop = roster.filter((r) => !r.departed && r.mood === topMood).length === 1;
  const team = roster
    .map((r) => {
      const d = employeeDef(r.definitionId);
      const isTop = singleTop && !r.departed && r.mood === topMood && topMood > 0;
      return `<li class="team-row${r.departed ? " gone" : ""}${isTop ? " top" : ""}">${portrait(d, "mini-portrait")}<span><strong>${esc(d.name)}</strong>${hearts(r.mood)}</span><em>${r.departed ? "已離職" : isTop ? "最高" : `${r.mood} 分`}</em></li>`;
    })
    .join("");
  const missed = Object.entries(m.missedHazards)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([id, pts]) => {
      const h = hazardOf(id);
      const card = content.cards.find((c) => c.hazardId === id);
      const hint = h?.fixHint ?? card?.fixHint ?? `${pts} 點未處理 → ${card?.name ?? ""}`;
      return `<li class="note cat-${esc(h?.category)}"><img src="assets/icons/${esc(id)}.svg" alt=""><span><strong>${esc(h?.name)}</strong><small>${esc(hint)}</small></span></li>`;
    })
    .join("");
  app.innerHTML = `
    <section class="hero result">
      <div class="eyebrow">${completed ? `${total} 回合挑戰完成` : "挑戰結束"}</div>
      <h1>${completed ? "團隊平安完成這一週！" : "這次沒能留住所有夥伴"}</h1>
      <p class="player-title">你的稱號｜${title}</p>
      <div class="stars" aria-label="${rating.stars} 顆星">${"★".repeat(rating.stars)}<i>${"★".repeat(3 - rating.stars)}</i></div>
      <p class="slogan">${esc(rating.slogan)}</p>
    </section>
    <ul class="team">${team}</ul>
    <div class="stats">
      <div><small>總分</small><strong>${engine.score()}</strong></div>
      <div><small>完成回合</small><strong>${st.completedRounds} / ${total}</strong></div>
      <div><small>留任夥伴</small><strong>${st.employees.length} 人</strong></div>
      <div><small>對症率</small><strong>${exactRate}%</strong></div>
    </div>
    <h2 class="section-title">妥善管理可能帶來的效益</h2>
    <ul class="benefits">${benefits.map(([t, ok]) => `<li class="${ok ? "ok" : ""}"><b>${ok ? "✓" : "—"}</b>${t}</li>`).join("")}</ul>
    <h2 class="section-title">本局觀察</h2>
    ${missed ? `<p class="small">最常被忽略的壓力與建議做法：</p><ul class="notes missed">${missed}</ul>` : '<p class="panel">每項風險都有被好好看見！</p>'}
    <div class="actions">
      <button class="primary" data-action="start">再玩一次</button>
      <button class="secondary" data-action="home">回到首頁</button>
    </div>`;
}

// ════════ 點擊 ════════
let suppressClick = false;
document.addEventListener("click", async (event) => {
  if (suppressClick) return;
  const sheetButton = event.target.closest("[data-sheet]");
  if (sheetButton) {
    closeSheet(sheetButton.dataset.sheet);
    return;
  }
  if (event.target === overlay) return;
  const cardButton = event.target.closest("[data-card]");
  if (cardButton && screen === "play") {
    const id = cardButton.dataset.card === "listen" ? "listen" : Number(cardButton.dataset.card);
    selectCard(id);
    return;
  }
  if (event.target.closest("[data-drop-target]") && screen === "play") {
    if (selected !== null) useSelected(game.front);
    else if (engine.state.playsRemaining > 0) {
      notice = "先從下方選一張卡，再點夥伴使用。";
      renderPlay();
    }
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "start") {
    if (screen === "cover" && readSave(fingerprint)) {
      const ok = await sheet("<h2>要開始新的一局嗎？</h2><p>上次還沒玩完的進度會被放棄。</p>", [
        { key: "no", label: "取消" },
        { key: "yes", label: "開始新的一局", primary: true },
      ]);
      if (ok !== "yes") return;
    }
    return startGame();
  }
  if (action === "resume") return resumeGame();
  if (action === "home") return renderCover(), scrollTop();
  if (action === "difficulty") {
    writePref({ ...readPref(), hard: button.dataset.hard === "1" });
    audio.play("button");
    return renderCover();
  }
  if (action === "toggle-feature") {
    const f = currentFeatures();
    const key = button.dataset.feature;
    writePref({ ...readPref(), [key === "specialEvents" ? "hard" : "combo"]: !f[key] });
    return renderCover();
  }
  if (action === "export-csv") return exportCsv();
  if (action === "clear-records") return clearRecords();
  if (action === "reload") return location.reload();
  if (screen !== "play") return;
  if (action === "switch") {
    pendingSwitch = null;
    const id = Number(button.dataset.employee);
    if (engine.state.employees.some((e) => e.instanceId === id)) {
      game.front = id;
      frontChanged = true;
      lastHint = null;
      notice = "";
      audio.play("button");
      persist();
      renderPlay();
    }
    return;
  }
  if (action === "use-tool") return useSelected(undefined);
  if (action === "review-confirm") return confirmReview();
  if (action === "review-cancel") {
    reviewPicks = null;
    selected = null;
    return renderPlay();
  }
  if (action === "reroll") return reroll();
  if (action === "end") return endRound();
  if (action === "mute") {
    audio.toggleMute();
    return renderPlay();
  }
  if (action === "volume") {
    audio.cycleVolume();
    audio.play("button");
    return renderPlay();
  }
  if (action === "leave") {
    const ok = await sheet("<h2>要回到首頁嗎？</h2><p>進度已經自動保存，之後可以從首頁「繼續上次的進度」回來。</p>", [
      { key: "stay", label: "繼續玩" },
      { key: "leave", label: "回到首頁", primary: true },
    ]);
    if (ok === "leave") {
      audio.stopMusic();
      renderCover();
      scrollTop();
    }
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches?.("[data-drop-target]")) {
    event.preventDefault();
    if (selected !== null) useSelected(game.front);
  }
  if (event.key === "Escape" && !overlay.hidden) closeSheet(null);
});
// 手機瀏覽器要等使用者碰畫面後才能發聲；iPhone 較舊的版本要在手指離開或點擊時才算數，所以都掛上
for (const type of ["pointerdown", "touchend", "click"]) document.addEventListener(type, () => audio.unlock(), { capture: true });

// ════════ 拖曳卡牌（滑鼠、觸控筆、手指都適用）════════
// 手機上：手牌可以左右滑動；手指往上拖才會拿起卡牌（左右滑交給瀏覽器捲動手牌）。
let drag = null;
function clearDrag() {
  if (!drag) return;
  cancelAnimationFrame(drag.frame);
  drag.ghost?.remove();
  drag.element.classList.remove("drag-source");
  document.querySelector("[data-drop-target]")?.classList.remove("drag-over");
  drag = null;
}
app.addEventListener("pointerdown", (event) => {
  const element = event.target.closest("[data-card]");
  if (!element || event.button !== 0 || screen !== "play" || reviewPicks) return;
  clearDrag();
  drag = { element, id: element.dataset.card, pointerId: event.pointerId, type: event.pointerType, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
});
app.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  const dx = drag.x - drag.startX;
  const dy = drag.y - drag.startY;
  if (!drag.moved) {
    const vertical = Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx);
    const anyMove = Math.hypot(dx, dy) > 8;
    if (!(drag.type === "mouse" ? anyMove : vertical || (anyMove && document.body.classList.contains("wide")))) return;
    if (engine.state.playsRemaining <= 0) {
      clearDrag();
      return;
    }
    drag.moved = true;
    if (applyPendingSwitch()) renderPlay(), (drag.element = app.querySelector(`[data-card="${drag.id}"]`) ?? drag.element);
    drag.element.setPointerCapture?.(event.pointerId);
    const id = drag.id === "listen" ? "listen" : Number(drag.id);
    selected = id;
    document.querySelectorAll("[data-card]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.card === drag.id)));
    document.querySelector("[data-drop-target]")?.classList.add("ready");
    drag.ghost = drag.element.cloneNode(true);
    drag.ghost.removeAttribute("data-card");
    drag.ghost.setAttribute("aria-hidden", "true");
    drag.ghost.classList.add("drag-ghost");
    document.body.append(drag.ghost);
    drag.element.classList.add("drag-source");
    const tick = () => {
      if (!drag?.moved) return;
      // 手指拖到畫面頂端附近時，頁面自動往上捲，讓上方的夥伴露出來
      if (drag.y < 80) window.scrollBy(0, -14);
      drag.frame = requestAnimationFrame(tick);
    };
    drag.frame = requestAnimationFrame(tick);
  }
  event.preventDefault();
  drag.ghost.style.left = `${drag.x}px`;
  drag.ghost.style.top = `${drag.y}px`;
  const over = document.elementFromPoint(drag.x, drag.y)?.closest("[data-drop-target]");
  document.querySelector("[data-drop-target]")?.classList.toggle("drag-over", !!over);
});
app.addEventListener("pointerup", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const { moved } = drag;
  const hit = moved && document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-drop-target]");
  clearDrag();
  if (!moved) return;
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  if (hit) useSelected(game.front);
  else renderPlay(); // 放在別處：保留選取，讓玩家也可以再點夥伴
});
app.addEventListener("pointercancel", clearDrag);
app.addEventListener("lostpointercapture", (event) => {
  if (drag && event.pointerId === drag.pointerId && !drag.moved) clearDrag();
});
window.addEventListener("blur", clearDrag);

// 橫放且畫面矮時，改成左右兩欄（夥伴在左、手牌在右）
const wideQuery = matchMedia("(orientation: landscape) and (max-height: 560px) and (min-width: 640px)");
const applyWide = () => document.body.classList.toggle("wide", wideQuery.matches);
wideQuery.addEventListener?.("change", applyWide);
applyWide();

// ════════ 試玩紀錄（?debug=1）════════
function exportCsv() {
  const csv = playtestRecordsToCsv(store.load());
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `iso45003-mobile-playtest-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function clearRecords() {
  const first = await sheet("<h2>清除全部試玩紀錄？</h2><p>這台裝置上的試玩紀錄都會被刪除。</p>", [
    { key: "no", label: "取消" },
    { key: "yes", label: "清除", primary: true },
  ]);
  if (first !== "yes") return;
  const second = await sheet("<h2>清除後無法復原</h2><p>仍要清除嗎？建議先匯出 CSV。</p>", [
    { key: "no", label: "取消" },
    { key: "yes", label: "確定清除", primary: true },
  ]);
  if (second === "yes") store.clear();
  renderCover();
}

// ════════ 自動更新（搭配 sw.js）════════
// 新版下載完成後：停在首頁就重新整理成新版；正在玩或看結算的人不打斷，回到首頁時才換。
let loadedVersion = null;
let updatePending = false;
function applyUpdateIfIdle() {
  if (updatePending && screen === "cover" && overlay.hidden) location.reload();
}
function requestUpdateCheck() {
  navigator.serviceWorker?.controller?.postMessage({ type: "check-update" });
}
function onUpdateMessage(event) {
  const data = event.data || {};
  if (data.type === "update-ready") updatePending = true;
  else if (data.type === "version") {
    if (!loadedVersion) loadedVersion = data.name;
    else if (data.name && data.name !== loadedVersion) updatePending = true;
  }
  applyUpdateIfIdle();
}
function setupServiceWorker() {
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!("serviceWorker" in navigator) || !(location.protocol === "https:" || local)) return;
  navigator.serviceWorker.addEventListener("message", onUpdateMessage);
  navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (navigator.serviceWorker.controller)
    fetch("__version")
      .then((r) => (r.ok ? r.text() : null))
      .then((v) => {
        if (v && !loadedVersion) loadedVersion = v;
      })
      .catch(() => {});
  setInterval(requestUpdateCheck, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestUpdateCheck();
  });
}

// ════════ 啟動 ════════
async function init() {
  try {
    const names = ["hazards", "cards", "employees", "bubbles", "balance", "features", "events"];
    const loaded = await Promise.all(
      names.map(async (name) => {
        const response = await fetch(`data/${name}.json`);
        if (!response.ok) throw new Error(`無法載入 data/${name}.json（${response.status}）`);
        return response.json();
      }),
    );
    content = Object.fromEntries(names.map((n, i) => [n, loaded[i]]));
    validateContent(content);
    fingerprint = contentFingerprint(content);
    renderCover();
    setupServiceWorker();
    MASCOTS.forEach((a) => (new Image().src = `assets/characters/${a}.webp`));
  } catch (error) {
    app.innerHTML = `<section class="panel"><h1>遊戲無法啟動</h1><p>${esc(error instanceof Error ? error.message : "未知錯誤")}</p><p>請確認網路後重試。此遊戲需透過網站網址開啟。</p><button class="primary" data-action="reload">重新載入</button></section>`;
    console.error(error);
  }
}

// 自動測試用（?e2e=1）：讓測試程式讀取目前狀態
if (E2E) {
  window.__GAME__ = {
    snapshot: () => {
      const st = engine?.state;
      return {
        screen,
        sheetOpen: !overlay.hidden,
        round: st?.round,
        phase: st?.phase,
        endReason: st?.endReason,
        playsRemaining: st?.playsRemaining,
        listeningAvailable: st?.listeningAvailable,
        rerollAvailable: st?.rerollAvailable,
        front: game?.front,
        selected,
        seed: engine?.seed,
        steps: game?.steps.length,
        hand: st?.hand.map((c) => ({ id: c.instanceId, def: c.definitionId })),
        tool: st?.managementTool ? { id: st.managementTool.instanceId, def: st.managementTool.definitionId } : null,
        employees: st?.employees.map((e) => ({ id: e.instanceId, def: e.definitionId, mood: e.mood, pressures: e.pressures.map((p) => ({ h: p.hazardId, p: p.points, hidden: p.hidden })) })),
        lastMessage: st?.lastMessage,
        resigned: st?.resigned,
        score: engine ? engine.score() : null,
      };
    },
  };
}

init();
