/**
 * 存檔與續玩
 *
 * 遊戲規則的隨機全部來自「種子」，所以只要記下「種子＋玩家做過的每一步」，
 * 重新開啟時用同一個種子把每一步重做一次，就能得到一模一樣的局面。
 * 存檔放在這台裝置的瀏覽器（localStorage），沒有雲端同步。
 *
 * 遊戲資料（data/*.json）一改，舊存檔就自動作廢，避免套用到不同的內容。
 */
import { GameEngine } from "./engine/GameEngine.js";

const SAVE_KEY = "iso45003-full-save";
const SAVE_VERSION = 1;

/** 由遊戲資料算出一個簡短的指紋，用來判斷存檔是否還適用。 */
export function contentFingerprint(content) {
  const text = JSON.stringify(content);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${SAVE_VERSION}-${(h >>> 0).toString(36)}`;
}

/** 依記錄的步驟重做一次，回傳 GameEngine；任何一步失敗就回傳 null。 */
export function replay(content, save) {
  try {
    const engine = new GameEngine({ ...content, features: save.features }, save.seed);
    for (const step of save.steps) {
      if (step.t === "listen") engine.listen(step.e);
      else if (step.t === "play") engine.playCard(step.c, step.e);
      else if (step.t === "review") engine.playReview(step.c, step.ids);
      else if (step.t === "reroll") engine.rerollHand();
      else if (step.t === "end") engine.endRound();
      else return null;
    }
    return engine;
  } catch {
    return null;
  }
}

export function writeSave(save) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    /* 無法儲存（例如私密瀏覽）時照常可以玩，只是不能續玩 */
  }
}

/** 讀出存檔；格式不對、資料已改版或局已結束則回傳 null。 */
export function readSave(fingerprint) {
  try {
    const save = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!save || save.fingerprint !== fingerprint || !Number.isInteger(save.seed) || !Array.isArray(save.steps)) return null;
    if (typeof save.features !== "object" || save.features === null) return null;
    return save;
  } catch {
    return null;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* 略過 */
  }
}
