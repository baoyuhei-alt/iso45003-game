// 規則與存檔測試（不需要瀏覽器）：node tests/rules.test.mjs
//
// 1. 規則程式（js/engine/GameEngine.js）必須和桌面原版那份已驗證過的檔案一字不差
// 2. 遊戲資料能通過啟動時的檢查
// 3. 存檔續玩：記下的步驟重做一次，必須得到完全相同的局面（隨機玩 1,000 局驗證）
// 4. 每一局都會在設定的回合數內結束
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GameEngine } from "../js/engine/GameEngine.js";
import { validateContent } from "../js/content/validateContent.js";
import { replay, contentFingerprint } from "../js/save.js";

const root = new URL("../", import.meta.url);
const VERIFIED_ENGINE_SHA256 = "affa1a51e8c3a8073ef506a9e0e6037ed23762375ff5fb068e9de32e59b9f60b";

const engineFile = await readFile(new URL("js/engine/GameEngine.js", root));
assert.equal(createHash("sha256").update(engineFile).digest("hex"), VERIFIED_ENGINE_SHA256, "規則程式被改過了，和已驗證的版本不同");
console.log("✓ 規則程式與桌面原版（已驗證）一字不差");

const content = {};
for (const n of ["hazards", "cards", "employees", "bubbles", "balance", "features", "events"])
  content[n] = JSON.parse(await readFile(new URL(`data/${n}.json`, root), "utf8"));
validateContent(content);
console.log(`✓ 遊戲資料通過檢查（${content.balance.totalRounds} 回合）`);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const snapshot = (e) => JSON.stringify(e.state);

let games = 0;
let checkpoints = 0;
const reasons = {};
for (let seed = 1; seed <= 1000; seed++) {
  const r = rng(seed);
  const features = { specialEvents: seed % 2 === 0, sameCategoryCombo: seed % 3 === 0 };
  const e = new GameEngine({ ...content, features }, seed);
  const save = { seed, features, steps: [] };
  for (let i = 0; i < 400 && e.state.phase !== "result"; i++) {
    const st = e.state;
    const emps = st.employees.map((x) => x.instanceId);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const roll = r();
    let step = null;
    try {
      if (roll < 0.12 && st.listeningAvailable && st.playsRemaining > 0) {
        step = { t: "listen", e: pick(emps) };
        e.listen(step.e);
      } else if (roll < 0.8 && st.playsRemaining > 0 && (st.hand.length || st.managementTool)) {
        const cards = [...st.hand, ...(st.managementTool ? [st.managementTool] : [])];
        step = { t: "play", c: pick(cards).instanceId, e: pick(emps) };
        e.playCard(step.c, step.e);
      } else if (roll < 0.86 && st.rerollAvailable && st.hand.length) {
        step = { t: "reroll" };
        e.rerollHand();
      } else {
        step = { t: "end" };
        e.endRound();
      }
    } catch {
      continue; // 不合規則的操作不記錄（畫面上也不會記錄）
    }
    save.steps.push(JSON.parse(JSON.stringify(step)));
    if (r() < 0.15) {
      const again = replay(content, save);
      assert.ok(again, `種子 ${seed}：續玩失敗`);
      assert.equal(snapshot(again), snapshot(e), `種子 ${seed} 第 ${i} 步：續玩後局面不同`);
      checkpoints++;
    }
  }
  assert.equal(e.state.phase, "result", `種子 ${seed}：沒有結束`);
  assert.ok(e.state.completedRounds <= content.balance.totalRounds);
  const again = replay(content, save);
  assert.equal(snapshot(again), snapshot(e), `種子 ${seed}：結束時續玩局面不同`);
  reasons[e.state.endReason] = (reasons[e.state.endReason] ?? 0) + 1;
  games++;
}
console.log(`✓ 隨機玩 ${games} 局、${checkpoints} 個中途存檔點：續玩後局面完全相同（結束方式：${JSON.stringify(reasons)}）`);

assert.equal(replay(content, { seed: 1, features: {}, steps: [{ t: "???" }] }), null);
assert.equal(replay(content, { seed: 1, features: {}, steps: [{ t: "listen", e: 99999 }] }), null);
console.log("✓ 壞掉的存檔會被拒絕（回到首頁重新開始）");

const changed = structuredClone(content);
changed.balance.totalRounds = 5;
assert.notEqual(contentFingerprint(changed), contentFingerprint(content));
console.log("✓ 遊戲資料一改，舊存檔就自動作廢");
console.log("\n全部通過");
