/**
 * 試玩紀錄的儲存：把每局紀錄存成一個 JSON 陣列，放在瀏覽器 localStorage。
 */

import { PLAYTEST_STORAGE_KEY } from "./playtest.js";

/**
 * 試玩紀錄的讀寫（傳入 window.localStorage）。
 */
export class PlaytestStore {
  constructor(storage) {
    this.storage = storage;
  }
  storage;

  /**
   * 讀出全部紀錄；沒有或格式錯誤時回傳空陣列。
   */
  load() {
    const raw = this.storage.getItem(PLAYTEST_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * 新增一筆紀錄。
   */
  append(record) {
    const records = this.load();
    records.push(record);
    this.storage.setItem(PLAYTEST_STORAGE_KEY, JSON.stringify(records));
  }

  /**
   * 清除全部紀錄。
   */
  clear() {
    this.storage.removeItem(PLAYTEST_STORAGE_KEY);
  }
}
