# 瀏覽器測試：在模擬手機上用各種操作玩很多局，檢查畫面與遊戲狀態一致、沒有錯誤。
# 需要：Python 3、playwright（pip install playwright）與 Chrome/Chromium。
# 用法：python3 tests/browser-check.py [局數]
import asyncio, functools, json, os, sys, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
GAMES = int(sys.argv[1]) if len(sys.argv) > 1 else 10
CHROME = os.environ.get("CHROME_PATH", "/opt/google/chrome/chrome")
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}/"
CARDS = {c["id"]: c for c in json.loads((ROOT / "data/cards.json").read_text(encoding="utf-8"))}

# 只計算遊戲自己的程式（js/ 資料夾）加的事件監聽；測試工具本身也會加，要排除
COUNT_LISTENERS = """(() => { window.__listeners = 0; const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (...a) { if ((new Error().stack || '').includes('/js/')) window.__listeners++; return add.apply(this, a); }; })();"""

# 畫面與遊戲狀態是否一致（回傳不一致的項目）
INVARIANTS = """(() => {
  const s = window.__GAME__.snapshot();
  if (s.screen !== 'play' || s.sheetOpen) return [];
  const errs = [];
  const count = (el) => ((el?.querySelector('.hearts')?.textContent || '').match(/♥/g) || []).length;
  const front = document.querySelector('.front');
  if (Number(front?.dataset.employee) !== s.front) errs.push('前面的夥伴不一致');
  const emp = s.employees.find(e => e.id === s.front);
  if (!emp) return errs.concat('找不到前面的夥伴');
  if (count(front) !== emp.mood) errs.push(`愛心 ${count(front)} 與心情 ${emp.mood} 不一致`);
  const notes = document.querySelectorAll('.stage .notes .note:not(.done-note)').length;
  if (notes !== emp.pressures.length) errs.push('壓力便條數不一致');
  if (document.querySelectorAll('.stage .hidden-note').length !== emp.pressures.filter(p => p.hidden).length) errs.push('隱藏壓力數不一致');
  const waiting = [...document.querySelectorAll('.waiting-person')];
  if (waiting.length !== s.employees.length - 1) errs.push('排隊人數不一致');
  for (const w of waiting) { const e = s.employees.find(x => x.id === Number(w.dataset.employee)); if (!e || count(w) !== e.mood) errs.push('排隊夥伴的心情不一致'); }
  if (document.querySelectorAll('.pips i.on').length !== s.playsRemaining) errs.push('行動格數不一致');
  const cards = document.querySelectorAll('.hand [data-card]').length;
  const expect = s.hand.length + (s.listeningAvailable ? 1 : 0) + (s.tool ? 1 : 0);
  if (cards !== expect) errs.push(`手牌 ${cards} 張與實際 ${expect} 張不一致`);
  if (document.querySelectorAll('.drag-ghost').length) errs.push('殘留拖曳影子');
  return errs;
})()"""

def rng(seed):
    a = seed & 0xFFFFFFFF
    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return nxt

results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'✓' if ok else '✗'} {name}{('：' + detail) if detail else ''}", flush=True)

async def new_context(b, w=390, h=844):
    return await b.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, device_scale_factor=2,
                               service_workers="block", user_agent=UA)

async def touch_drag(cdp, page, card_sel):
    """真正的手指拖曳：往上拖到前面的夥伴身上（必要時拖到畫面頂端等頁面捲動）"""
    pt = lambda x, y: [{"x": x, "y": y, "id": 1, "radiusX": 5, "radiusY": 5, "force": 1}]
    c = await page.locator(card_sel).bounding_box()
    x, y = c["x"] + c["width"] / 2, c["y"] + c["height"] / 2
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pt(x, y)})
    for k in range(1, 7):
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pt(x, y - k * 6)})
        await page.wait_for_timeout(16)
    y -= 36
    for _ in range(60):
        t = await page.locator("[data-drop-target]").bounding_box()
        if t and t["y"] >= 20:
            break
        y = 30
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pt(x, y)})
        await page.wait_for_timeout(50)
    sx, sy = x, y
    for k in range(1, 9):
        t = await page.locator("[data-drop-target]").bounding_box()
        tx, ty = t["x"] + t["width"] / 2, t["y"] + t["height"] / 2
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pt(sx + (tx - sx) * k / 8, sy + (ty - sy) * k / 8)})
        await page.wait_for_timeout(16)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await page.wait_for_timeout(80)

async def random_games(b):
    ctx = await new_context(b)
    page = await ctx.new_page()
    await page.add_init_script(COUNT_LISTENERS)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    cdp = await ctx.new_cdp_session(page)
    snap = lambda: page.evaluate("window.__GAME__.snapshot()")
    stats = {"點選出牌": 0, "手指拖曳出牌": 0, "顧問直接使用": 0, "換人": 0, "整手換牌": 0, "結算回合": 0, "中途重開續玩": 0, "自動換下一位": 0}
    mismatches, resume_bad, finished, drag_miss = [], [], {}, []
    for g in range(GAMES):
        seed = 100 + g
        r = rng(seed)
        await page.goto(BASE + f"?e2e=1&seed={seed}", wait_until="networkidle")
        await page.evaluate(f"localStorage.setItem('iso45003-full-pref', JSON.stringify({{hard: {str(g % 2 == 1).lower()}, combo: {str(g % 3 == 0).lower()}}}))")
        await page.reload(wait_until="networkidle")
        await page.locator('[data-action="start"]').tap()
        for _ in range(400):
            s = await snap()
            if s["screen"] == "result":
                break
            if s["sheetOpen"]:
                await page.locator(".sheet .primary").tap(); await page.wait_for_timeout(40); continue
            before_front, before_solved = s["front"], None
            roll = r()
            waiting = [e for e in s["employees"] if e["id"] != s["front"]]
            if roll < 0.04:  # 中途重新整理，再按「繼續上次的進度」
                keep = {k: s[k] for k in ("round", "playsRemaining", "hand", "employees", "seed", "steps", "tool", "front")}
                await page.reload(wait_until="networkidle")
                await page.locator('[data-action="resume"]').tap(); await page.wait_for_timeout(60)
                again = await snap()
                if {k: again[k] for k in keep} != keep:
                    resume_bad.append(seed)
                stats["中途重開續玩"] += 1
                continue
            if roll < 0.14 and waiting:
                w = waiting[int(r() * len(waiting))]
                await page.locator(f'.waiting-person[data-employee="{w["id"]}"]').tap(); stats["換人"] += 1
            elif s["playsRemaining"] > 0 and roll < 0.84:
                ids = await page.eval_on_selector_all(".hand [data-card]", "els => els.map(e => e.dataset.card)")
                if not ids:
                    await page.locator('[data-action="end"]').tap(); stats["結算回合"] += 1; continue
                # 偏向出「對症」的牌，讓局面更接近真實玩家
                front = next(e for e in s["employees"] if e["id"] == s["front"])
                want = {p["h"] for p in front["pressures"] if not p["hidden"]}
                good = [i for i in ids if i != "listen" and CARDS[next((h["def"] for h in s["hand"] if str(h["id"]) == i), s["tool"]["def"] if s["tool"] and str(s["tool"]["id"]) == i else "consultant")].get("hazardId") in want]
                if any(p["hidden"] for p in front["pressures"]) and "listen" in ids and r() < 0.7:
                    pick = "listen"
                elif good and r() < 0.7:
                    pick = good[int(r() * len(good))]
                else:
                    pick = ids[int(r() * len(ids))]
                solved_before = len(front["pressures"])
                is_tool = s["tool"] and str(s["tool"]["id"]) == pick
                if s["selected"] is not None and str(s["selected"]) == pick:
                    await page.locator("[data-drop-target]").tap(); stats["點選出牌"] += 1
                elif is_tool and r() < 0.5:
                    await page.locator(f'[data-card="{pick}"]').tap()
                    await page.locator('[data-action="use-tool"]').tap(); stats["顧問直接使用"] += 1
                elif r() < 0.3:
                    await page.locator(f'[data-card="{pick}"]').scroll_into_view_if_needed()
                    await touch_drag(cdp, page, f'[data-card="{pick}"]'); stats["手指拖曳出牌"] += 1
                    if (await snap())["steps"] == s["steps"]:
                        drag_miss.append((seed, s["round"], pick))
                else:
                    await page.locator(f'[data-card="{pick}"]').tap()
                    await page.locator("[data-drop-target]").tap(); stats["點選出牌"] += 1
            elif roll < 0.9 and s["rerollAvailable"]:
                await page.locator('[data-action="reroll"]').tap(); stats["整手換牌"] += 1
            else:
                await page.locator('[data-action="end"]').tap(); stats["結算回合"] += 1
            await page.wait_for_timeout(60)
            after = await snap()
            if after["screen"] == "play" and not after["sheetOpen"] and after["front"] != before_front and after["round"] == s["round"]:
                if not (roll < 0.14 and waiting):
                    stats["自動換下一位"] += 1
            bad = await page.evaluate(INVARIANTS)
            if bad:
                mismatches.append((seed, bad))
        s = await snap()
        finished[s["endReason"]] = finished.get(s["endReason"], 0) + 1
        await page.locator('[data-action="home"]').tap()
    total = sum(finished.values())
    check(f"隨機玩 {GAMES} 局（點選、手指拖曳、換人、換牌、中途重開）都能玩到結算", total == GAMES and None not in finished, f"結束方式 {finished}")
    print("   操作次數：" + "、".join(f"{k} {v}" for k, v in stats.items()))
    check("每一步之後，畫面（愛心、壓力便條、排隊、行動格、手牌）都和實際狀態一致", not mismatches, str(mismatches[:3]))
    check("手指拖曳每一次都成功出牌", not drag_miss, f"{stats['手指拖曳出牌']} 次，失敗 {drag_miss[:5]}")
    check("中途重新整理後「繼續上次的進度」，局面完全相同", not resume_bad and stats["中途重開續玩"] > 0, f"{stats['中途重開續玩']} 次，失敗 {resume_bad}")
    check("前面的夥伴處理完會自動換下一位上前", stats["自動換下一位"] > 0, f"{stats['自動換下一位']} 次")
    check("沒有瀏覽器錯誤", not errors, str(errors[:3]))
    await ctx.close()

async def interaction_details(b):
    ctx = await new_context(b)
    page = await ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    cdp = await ctx.new_cdp_session(page)
    snap = lambda: page.evaluate("window.__GAME__.snapshot()")
    pt = lambda x, y: [{"x": x, "y": y, "id": 1, "radiusX": 5, "radiusY": 5, "force": 1}]
    await page.goto(BASE + "?e2e=1&seed=7", wait_until="networkidle")
    await page.evaluate("localStorage.setItem('iso45003-full-pref', JSON.stringify({hard: false}))")
    await page.reload(wait_until="networkidle")
    await page.locator('[data-action="start"]').tap()
    # 快轉到第 3 回合（3 位夥伴、手牌較多）
    for _ in range(30):
        s = await snap()
        if s["round"] >= 3 and not s["sheetOpen"]:
            break
        await page.locator(".sheet .primary" if s["sheetOpen"] else '[data-action="end"]').tap()
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    hand = page.locator(".hand")
    box = await hand.bounding_box()
    width = await hand.evaluate("h => h.scrollWidth - h.clientWidth")
    before = await snap()
    x0, y0 = box["x"] + box["width"] - 40, box["y"] + box["height"] / 2
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pt(x0, y0)})
    for k in range(1, 16):
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pt(x0 - k * 15, y0 + k * 0.5)})
        await page.wait_for_timeout(16)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await page.wait_for_timeout(300)
    scrolled = await hand.evaluate("h => h.scrollLeft")
    after = await snap()
    check("手指左右滑手牌：手牌捲動，不會誤拿起卡牌或出牌", width <= 0 or (scrolled > 0 and after["steps"] == before["steps"] and await page.locator(".drag-ghost").count() == 0),
          f"可捲動 {width}px，實際捲動 {scrolled}px，出牌次數不變={after['steps'] == before['steps']}")
    # 選最後一張牌：手牌位置不跳回最左邊
    ids = await page.eval_on_selector_all(".hand [data-card]", "els => els.map(e => e.dataset.card)")
    await page.locator(f'[data-card="{ids[-1]}"]').tap(); await page.wait_for_timeout(100)
    visible = await page.evaluate(f"""(() => {{ const h = document.querySelector('.hand').getBoundingClientRect(); const c = document.querySelector('[data-card="{ids[-1]}"]').getBoundingClientRect(); return c.left >= h.left - 1 && c.right <= h.right + 1; }})()""")
    front_ok = await page.evaluate("(() => { const f = document.querySelector('.front').getBoundingClientRect(); const t = document.querySelector('.tray').getBoundingClientRect(); return f.bottom <= t.top && f.top >= 0; })()")
    check("點最後一張牌：牌留在畫面中、前面的夥伴沒被手牌區蓋住", visible and front_ok, f"牌在畫面中={visible}、夥伴看得到={front_ok}")
    # 沒選卡就點夥伴 → 提示先選卡
    await page.locator('[data-card="' + ids[-1] + '"]').tap()  # 取消剛才的選取
    await page.locator("[data-drop-target]").tap(); await page.wait_for_timeout(80)
    hint = await page.locator(".tray .message").inner_text()
    check("沒選卡就點夥伴：提示「先選一張卡」", "先從下方選一張卡" in hint, hint)
    # 快速連點兩下「結算本回合」
    await page.locator(".sheet .primary").count()
    s = await snap()
    btn = await page.locator('[data-action="end"]').bounding_box()
    cx, cy = btn["x"] + btn["width"] / 2, btn["y"] + btn["height"] / 2
    await page.touchscreen.tap(cx, cy); await page.touchscreen.tap(cx, cy); await page.wait_for_timeout(150)
    s2 = await snap()
    check("快速連點兩下「結算本回合」只結算一次", s2["round"] == s["round"] + 1 or (s2["phase"] == "result" and s["round"] == 4), f"第 {s['round']} 回合 → 第 {s2['round']} 回合")
    while (await snap())["sheetOpen"]:
        await page.locator(".sheet .primary").tap()
    # 離開 → 首頁 → 繼續
    s = await snap()
    await page.locator('[data-action="leave"]').tap()
    await page.locator('.sheet [data-sheet="leave"]').tap()
    on_cover = await page.locator('[data-action="resume"]').count()
    await page.locator('[data-action="resume"]').tap(); await page.wait_for_timeout(80)
    s2 = await snap()
    check("按「離開」回首頁後，可以「繼續上次的進度」", on_cover == 1 and s2["steps"] == s["steps"] and s2["hand"] == s["hand"], f"首頁有繼續按鈕={on_cover == 1}、局面相同={s2['hand'] == s['hand']}")
    # 遊戲中轉向 20 次
    for k in range(20):
        await page.set_viewport_size({"width": 844, "height": 390} if k % 2 == 0 else {"width": 390, "height": 844})
        await page.wait_for_timeout(30)
    await page.set_viewport_size({"width": 844, "height": 390}); await page.wait_for_timeout(100)
    wide = await page.evaluate("document.body.classList.contains('wide')")
    btn_visible = await page.evaluate("(() => { const b = document.querySelector('[data-action=\"end\"]').getBoundingClientRect(); return b.bottom <= innerHeight && b.top >= 0; })()")
    await page.set_viewport_size({"width": 390, "height": 844}); await page.wait_for_timeout(100)
    bad = await page.evaluate(INVARIANTS)
    check("遊戲中快速轉向 20 次：版面正確切換、橫放時按鈕看得到、狀態不變", wide and btn_visible and not bad, f"橫放兩欄={wide}、結算按鈕在畫面內={btn_visible}")
    check("細部操作測試沒有瀏覽器錯誤", not errors, str(errors[:3]))
    await ctx.close()

async def no_buildup(b):
    ctx = await new_context(b)
    page = await ctx.new_page()
    await page.add_init_script(COUNT_LISTENERS)
    snap = lambda: page.evaluate("window.__GAME__.snapshot()")
    await page.goto(BASE + "?e2e=1&seed=11", wait_until="networkidle")
    counts, nodes = [], []
    for g in range(4):
        counts.append(await page.evaluate("window.__listeners"))
        nodes.append(await page.evaluate("document.getElementsByTagName('*').length"))
        await page.locator('[data-action="start"]').tap()
        for _ in range(60):
            s = await snap()
            if s["screen"] == "result":
                break
            if s["sheetOpen"]:
                await page.locator(".sheet .primary").tap(); continue
            ids = await page.eval_on_selector_all(".hand [data-card]", "els => els.map(e => e.dataset.card)")
            if s["playsRemaining"] > 0 and ids:
                await page.locator(f'[data-card="{ids[0]}"]').tap(); await page.locator("[data-drop-target]").tap()
            else:
                await page.locator('[data-action="end"]').tap()
        await page.locator('[data-action="home"]').tap()
    check("同一頁連玩 4 局：事件監聽數量與頁面元素不會越來越多", len(set(counts)) == 1 and len(set(nodes)) == 1, f"每局回到首頁時：監聽 {counts}、元素 {nodes}")
    await ctx.close()

async def playtest_and_audio(b):
    # 試玩紀錄：玩一局完成、一局中途放棄，再匯出 CSV
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, service_workers="block", accept_downloads=True, user_agent=UA)
    page = await ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    snap = lambda: page.evaluate("window.__GAME__.snapshot()")
    await page.goto(BASE + "?e2e=1&debug=1&seed=3&tester=測試員", wait_until="networkidle")
    await page.locator('[data-action="start"]').tap()
    for _ in range(40):
        s = await snap()
        if s["screen"] == "result":
            break
        await page.locator(".sheet .primary" if s["sheetOpen"] else '[data-action="end"]').tap()
    await page.locator('[data-action="home"]').tap()
    await page.locator('[data-action="start"]').tap()
    await page.locator('[data-action="end"]').tap(); await page.locator(".sheet .primary").tap()
    await page.locator('[data-action="leave"]').tap(); await page.locator('.sheet [data-sheet="leave"]').tap()
    await page.locator('[data-action="start"]').tap()  # 開新局時，上一局記成「未完成」
    confirm = await page.locator(".sheet").inner_text()
    await page.locator('.sheet [data-sheet="yes"]').tap()
    await page.locator('[data-action="leave"]').tap(); await page.locator('.sheet [data-sheet="leave"]').tap()
    async with page.expect_download() as d:
        await page.locator('[data-action="export-csv"]').tap()
    path = await (await d.value).path()
    text = Path(path).read_bytes().decode("utf-8-sig")  # 保留 \r\n（Excel 用的換行）
    rows = [r for r in text.split("\r\n") if r]
    results_col = [r.split(",")[4] for r in rows[1:]]
    ok = len(rows) == 3 and rows[0].startswith("試玩者") and results_col[0] in ("通關", "失敗") and results_col[1] == "未完成" and "測試員" in rows[1]
    check("試玩紀錄 CSV：玩完的局記「通關／失敗」、中途放棄的局記「未完成」", ok, f"共 {len(rows) - 1} 筆：{results_col}")
    check("有未完成的進度時按「開始」，會先確認是否放棄", "會被放棄" in confirm, confirm.splitlines()[0])
    await ctx.close()
    # 音效：不加 e2e，正常模式開局，確認音檔有下載、沒有錯誤
    ctx = await new_context(b)
    page = await ctx.new_page()
    errs2, mp3 = [], []
    page.on("pageerror", lambda e: errs2.append(str(e)))
    page.on("console", lambda m: errs2.append(m.text) if m.type == "error" else None)
    page.on("requestfinished", lambda r: mp3.append(r.url) if r.url.endswith(".mp3") else None)
    await page.goto(BASE, wait_until="networkidle")
    await page.locator('[data-action="start"]').tap(); await page.wait_for_timeout(2500)
    await page.locator('[data-card="listen"]').tap(); await page.locator("[data-drop-target]").tap(); await page.wait_for_timeout(1600)
    await page.locator('[data-action="mute"]').tap(); await page.locator('[data-action="volume"]').tap()
    label = await page.locator('[data-action="mute"]').inner_text()
    await page.reload(wait_until="networkidle")
    await page.locator('[data-action="resume"]').tap()
    label2 = await page.locator('[data-action="mute"]').inner_text()
    check("正常模式：碰畫面後載入音效、靜音設定會被記住", len(set(mp3)) == 9 and label == "已靜音" and label2 == "已靜音" and not errs2,
          f"下載 {len(set(mp3))} 個音檔、靜音後重開仍是「{label2}」、錯誤 {errs2[:2]}")
    await ctx.close()

async def main():
    t0 = time.time()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
        await random_games(b)
        await interaction_details(b)
        await no_buildup(b)
        await playtest_and_audio(b)
        await b.close()
    srv.shutdown()
    print(f"\n{'全部通過' if all(results) else '有項目未通過'}（{round(time.time() - t0)} 秒）")
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
