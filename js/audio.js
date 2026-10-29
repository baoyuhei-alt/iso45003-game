/**
 * 音效與背景音樂（手機版）
 *
 * 手機瀏覽器規定：使用者先碰一下畫面，網頁才可以發出聲音。
 * 所以第一次觸碰時才建立 AudioContext 並開始下載音檔（unlock）。
 * 切到別的 App 或鎖螢幕時自動暫停，回來再繼續。
 * 靜音與音量的選擇會記在這台裝置上。
 */
const SOUND_KEYS = ["play", "exact", "category", "unrelated", "resign", "win", "lose", "button", "music"];
const PREF_KEY = "iso45003-full-audio";
const VOLUMES = [0.3, 0.7, 1];
const VOLUME_LABELS = ["音量低", "音量中", "音量高"];

export class GameAudio {
  constructor(disabled = false) {
    this.disabled = disabled; // 自動測試模式不發聲
    this.context = null;
    this.buffers = new Map();
    this.loading = null;
    this.music = null; // { source, gain }
    this.wantMusic = false;
    const pref = readPref();
    this.muted = pref.muted === true;
    this.volumeIndex = Number.isInteger(pref.volumeIndex) && VOLUMES[pref.volumeIndex] ? pref.volumeIndex : 1;
    document.addEventListener("visibilitychange", () => {
      if (!this.context) return;
      if (document.visibilityState === "hidden") this.context.suspend().catch(() => {});
      else this.context.resume().catch(() => {});
    });
  }

  get volume() {
    return VOLUMES[this.volumeIndex];
  }
  get volumeLabel() {
    return VOLUME_LABELS[this.volumeIndex];
  }

  /** 使用者第一次碰畫面時呼叫：建立聲音環境並開始下載音檔。 */
  unlock() {
    if (this.disabled) return;
    if (!this.context) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.context = new Ctx();
      this.loading = this.loadAll();
    }
    if (this.context.state === "suspended") this.context.resume().catch(() => {});
  }

  async loadAll() {
    await Promise.all(
      SOUND_KEYS.map(async (key) => {
        try {
          const response = await fetch(`assets/audio/${key}.mp3`);
          if (!response.ok) return;
          const data = await response.arrayBuffer();
          const buffer = await new Promise((resolve, reject) => this.context.decodeAudioData(data, resolve, reject));
          this.buffers.set(key, buffer);
          if (key === "music" && this.wantMusic) this.startMusic();
        } catch {
          /* 某個音檔載入失敗就略過，不影響遊戲 */
        }
      }),
    );
  }

  /** 播放一個音效。 */
  play(key) {
    if (this.disabled || this.muted || !this.context) return;
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    gain.gain.value = this.volume * 0.9;
    source.buffer = buffer;
    source.connect(gain).connect(this.context.destination);
    source.start();
  }

  /** 開始循環播放背景音樂（已在播放就不重複）。 */
  startMusic() {
    this.wantMusic = true;
    if (this.disabled || this.muted || !this.context || this.music) return;
    const buffer = this.buffers.get("music");
    if (!buffer) return; // 還沒下載完，下載完會自動開始
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    gain.gain.value = this.volume * 0.72;
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain).connect(this.context.destination);
    source.start();
    this.music = { source, gain };
  }

  /** 停止背景音樂。 */
  stopMusic() {
    this.wantMusic = false;
    if (!this.music) return;
    try {
      this.music.source.stop();
    } catch {
      /* 已經停了 */
    }
    this.music = null;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.muted) {
      const want = this.wantMusic;
      this.stopMusic();
      this.wantMusic = want;
    } else if (this.wantMusic) this.startMusic();
    this.savePref();
  }

  /** 音量循環：中 → 高 → 低 → 中 */
  cycleVolume() {
    this.volumeIndex = (this.volumeIndex + 1) % VOLUMES.length;
    if (this.music) this.music.gain.gain.value = this.volume * 0.72;
    this.savePref();
  }

  savePref() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ muted: this.muted, volumeIndex: this.volumeIndex }));
    } catch {
      /* 無法儲存也沒關係 */
    }
  }
}

function readPref() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
  } catch {
    return {};
  }
}
