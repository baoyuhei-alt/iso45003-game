// 離線快取與自動更新（Service Worker）
//
// 運作方式：
// 1. 第一次開啟：把 FILES 全部下載存起來，之後沒有網路也能玩。
// 2. 平常開啟：一律先用存好的檔案，所以開啟很快、同一次開啟裡的檔案一定是同一版。
// 3. 每次開啟頁面時，在背景檢查伺服器上的檔案有沒有變（沒變的檔案伺服器只回「沒變」，幾乎不花流量）。
//    有變就把整套新檔案下載到新的快取，全部成功才切換；途中失敗就繼續用舊版。
// 4. 新版準備好後通知頁面：停在封面的頁面會自動重新整理成新版；正在玩的人不受影響，下次開啟才換。
//
// 發布新版時不需要修改這個檔案。只有新增或刪除網站檔案時，才需要更新下面的 FILES 清單
// （沒列進去的檔案仍會在第一次用到時存起來，但離線前沒用過就不會有）。
const PREFIX = 'iso45003-full-';
const META = PREFIX + 'meta';
const CHECK_INTERVAL = 60 * 1000; // 兩次檢查更新至少間隔 1 分鐘
const FILES = ["./", "./apple-touch-icon.png", "./assets/audio/button.mp3", "./assets/audio/category.mp3", "./assets/audio/exact.mp3", "./assets/audio/lose.mp3", "./assets/audio/music.mp3", "./assets/audio/play.mp3", "./assets/audio/resign.mp3", "./assets/audio/unrelated.mp3", "./assets/audio/win.mp3", "./assets/brand/company-logo.webp", "./assets/characters/mascot-care.webp", "./assets/characters/mascot-energy.webp", "./assets/characters/mascot-hope.webp", "./assets/characters/mascot-nature.webp", "./assets/characters/mascot-peace.webp", "./assets/icons/consultant.svg", "./assets/icons/counseling.svg", "./assets/icons/equipment.svg", "./assets/icons/isolation.svg", "./assets/icons/listen.svg", "./assets/icons/noiseTemperature.svg", "./assets/icons/organizationalChange.svg", "./assets/icons/reroll.svg", "./assets/icons/respect.svg", "./assets/icons/roleClarity.svg", "./assets/icons/schedule.svg", "./assets/icons/support.svg", "./assets/icons/workLifeBalance.svg", "./assets/icons/workload.svg", "./data/balance.json", "./data/bubbles.json", "./data/cards.json", "./data/employees.json", "./data/events.json", "./data/features.json", "./data/hazards.json", "./icon-192.png", "./icon-512.png", "./index.html", "./js/app.js", "./js/audio.js", "./js/config/query.js", "./js/content/validateContent.js", "./js/engine/GameEngine.js", "./js/playtest/PlaytestStore.js", "./js/playtest/playtest.js", "./js/save.js", "./manifest.webmanifest", "./styles.css"];

let lastCheck = 0;
let checking = null;

// 目前使用中的快取名稱（記在一個小小的 meta 快取裡）
async function currentCacheName() {
  const response = await (await caches.open(META)).match('current');
  return response ? response.text() : null;
}
async function setCurrentCacheName(name) {
  await (await caches.open(META)).put('current', new Response(name));
}

// 向伺服器取得全部檔案（cache: 'no-cache' 會帶上「我已經有這版」的資訊，沒變的檔案伺服器只回 304）。
// 任何一個失敗就整批放棄，避免新舊混用。
async function fetchAll() {
  return Promise.all(FILES.map(async url => {
    const response = await fetch(url, {cache: 'no-cache'});
    if (!response.ok) throw new Error('無法下載 ' + url);
    return [url, response];
  }));
}
async function storeAll(name, entries) {
  const cache = await caches.open(name);
  await Promise.all(entries.map(([url, response]) => cache.put(url, response)));
}
async function sameContent(a, b) {
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return false;
  const u = new Uint8Array(x), v = new Uint8Array(y);
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  return true;
}

// 檢查並下載新版；成功時通知所有開著的頁面
function checkForUpdate() {
  const now = Date.now();
  if (checking || now - lastCheck < CHECK_INTERVAL) return checking || Promise.resolve();
  lastCheck = now;
  checking = (async () => {
    const name = await currentCacheName();
    if (!name) return;
    const cache = await caches.open(name);
    const fresh = await fetchAll();
    let changed = false;
    for (const [url, response] of fresh) {
      const saved = await cache.match(url);
      if (!saved || !(await sameContent(saved, response.clone()))) { changed = true; break; }
    }
    if (!changed) return;
    const next = PREFIX + Date.now();
    await storeAll(next, fresh);
    await setCurrentCacheName(next);
    await caches.delete(name);
    for (const client of await self.clients.matchAll({type: 'window'})) client.postMessage({type: 'update-ready', name: next});
  })().catch(() => { /* 沒網路或下載失敗：繼續用目前的版本 */ }).finally(() => { checking = null; });
  return checking;
}

self.addEventListener('install', event => event.waitUntil((async () => {
  if (!(await currentCacheName())) {
    const name = PREFIX + Date.now();
    await storeAll(name, await fetchAll());
    await setCurrentCacheName(name);
  }
  await self.skipWaiting();
})()));

// 啟用時刪掉舊的快取（包含改版前用手動版本號命名的快取）
self.addEventListener('activate', event => event.waitUntil((async () => {
  const current = await currentCacheName();
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== current && key !== META).map(key => caches.delete(key)));
  await self.clients.claim();
})()));

// 頁面要求檢查新版（一直開著的頁面定期呼叫）；檢查完回覆目前的版本，頁面據此判斷自己是不是舊版
self.addEventListener('message', event => {
  if (event.data?.type !== 'check-update') return;
  event.waitUntil(checkForUpdate().then(async () => {
    const name = await currentCacheName();
    if (name && event.source) event.source.postMessage({type: 'version', name});
  }));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  // 頁面開啟時詢問「目前是哪一版」
  if (new URL(request.url).pathname.endsWith('/__version')) {
    event.respondWith(currentCacheName().then(name => new Response(name || '', {headers: {'Cache-Control': 'no-store'}})));
    return;
  }
  if (request.mode === 'navigate') event.waitUntil(checkForUpdate());
  event.respondWith((async () => {
    const name = await currentCacheName();
    const cache = name ? await caches.open(name) : null;
    const saved = cache && await cache.match(request, {ignoreSearch: true});
    if (saved) return saved;
    try {
      const response = await fetch(request);
      if (response.ok && cache) cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (request.mode === 'navigate' && cache) {
        const page = await cache.match('./');
        if (page) return page;
      }
      throw error;
    }
  })());
});
