# 離線與自動更新測試（約 6 分鐘；加 --kiosk 另外測「一直停在首頁的平板」，再多約 5 分鐘）
# 用法：python3 tests/offline-update-check.py [--kiosk]
import asyncio, functools, os, shutil, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.async_api import async_playwright

SRC = Path(__file__).resolve().parent.parent
CHROME = os.environ.get("CHROME_PATH", "/opt/google/chrome/chrome")
site = Path(tempfile.mkdtemp()) / "site"
shutil.copytree(SRC, site, ignore=shutil.ignore_patterns("tests", "*.md", "preview.mjs"))

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(site)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}/"
FILES = sum(1 for _ in SRC.rglob("*") if _.is_file() and "tests" not in _.parts and _.suffix not in (".md",) and _.name not in ("preview.mjs", "sw.js")) + 1

def edit(rel, old, new):
    time.sleep(1.1)  # 讓檔案修改時間不同（伺服器用它判斷有沒有變）
    p = site / rel
    t = p.read_text(encoding="utf-8")
    assert old in t, (rel, old)
    p.write_text(t.replace(old, new), encoding="utf-8")

results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'✓' if ok else '✗'} {name}{('：' + detail) if detail else ''}", flush=True)

async def wait_text(page, text, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if text in await page.content():
                return True
        except Exception:
            pass
        await asyncio.sleep(0.3)
    return False

async def cache_state(page):
    return await page.evaluate("""(async () => {
      const keys = await caches.keys();
      const meta = await (await caches.open('iso45003-full-meta')).match('current');
      const current = meta ? await meta.text() : null;
      const count = current ? (await (await caches.open(current)).keys()).length : 0;
      return { keys, current, count };
    })()""")

async def main():
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await pg.goto(BASE, wait_until="networkidle")
        await pg.evaluate("navigator.serviceWorker.ready")
        for _ in range(40):
            st = await cache_state(pg)
            if st["count"] >= FILES:
                break
            await asyncio.sleep(0.5)
        check("第一次開啟：整個遊戲存進手機", st["count"] >= FILES, f"已存 {st['count']} 個檔案")
        await pg.reload(wait_until="networkidle")

        await ctx.set_offline(True)
        await pg.reload(wait_until="load")
        await pg.wait_for_selector('[data-action="start"]', timeout=10000)
        await pg.locator('[data-action="start"]').tap()
        await pg.locator('[data-card="listen"]').tap(); await pg.locator("[data-drop-target]").tap()
        try:
            await pg.wait_for_function("[...document.images].every(i => i.complete)", timeout=5000)
        except Exception:
            pass
        img_ok = await pg.evaluate("[...document.images].every(i => i.complete && i.naturalWidth > 0)")
        played = await pg.evaluate("JSON.parse(localStorage.getItem('iso45003-full-save')).steps.length")
        check("沒有網路時：可以開啟、開局、出牌，圖片都正常", img_ok and played == 1, f"圖片正常={img_ok}、已出牌 {played} 次")
        await ctx.set_offline(False)
        await pg.evaluate("localStorage.clear()")
        await pg.goto(BASE, wait_until="networkidle")
        print("（等待 61 秒：同一分鐘內不重複檢查更新）", flush=True); await asyncio.sleep(61)

        edit("js/app.js", "開始照顧團隊</button>", "開始照顧團隊（新版一）</button>")
        loads = []
        pg.on("load", lambda: loads.append(1))
        await pg.reload(wait_until="networkidle")
        auto = await wait_text(pg, "新版一")
        await asyncio.sleep(2)
        check("發布新版：停在首頁的頁面自動換成新版（不用改任何版本號）", auto and len(loads) == 2, f"自動重新整理 {len(loads) - 1} 次、顯示新版={auto}")
        print("（等待 61 秒）", flush=True); await asyncio.sleep(61)

        player = await ctx.new_page()
        player.on("pageerror", lambda e: errors.append(str(e)))
        await player.goto(BASE, wait_until="networkidle")
        await player.locator('[data-action="start"]').tap()
        await player.locator('[data-card="listen"]').tap(); await player.locator("[data-drop-target]").tap()
        print("（玩家在遊戲中；等待 61 秒後發布新版）", flush=True); await asyncio.sleep(61)
        edit("js/app.js", "<small>行動 ${actionsLeft}</small>", "<small>行動數 ${actionsLeft}</small>")
        other = await ctx.new_page()
        await other.goto(BASE, wait_until="networkidle")  # 另一個人開啟 → 背景下載新版
        await asyncio.sleep(6)
        await other.close()
        still_old = "行動數" not in await player.content() and await player.locator(".hand").count() == 1
        ids = await player.eval_on_selector_all(".hand [data-card]", "els => els.map(e => e.dataset.card)")
        await player.locator(f'[data-card="{ids[0]}"]').tap(); await player.locator("[data-drop-target]").tap()
        steps = await player.evaluate("JSON.parse(localStorage.getItem('iso45003-full-save')).steps.length")
        check("有人正在玩時不會被強制換版，可以繼續出牌", still_old and steps == 2, f"仍是原本畫面={still_old}、出牌 {steps} 次")
        await player.locator('[data-action="leave"]').tap(); await player.locator('.sheet [data-sheet="leave"]').tap()
        await asyncio.sleep(3)
        await player.locator('[data-action="resume"]').tap()
        new_now = "行動數" in await player.content()
        steps2 = await player.evaluate("JSON.parse(localStorage.getItem('iso45003-full-save')).steps.length")
        check("回到首頁時換成新版，「繼續上次的進度」保留原本的局", new_now and steps2 == 2, f"新版={new_now}、進度 {steps2} 步")
        await player.close()
        print("（等待 61 秒）", flush=True); await asyncio.sleep(61)

        edit("js/app.js", "新版一", "新版三")
        time.sleep(1.1)
        (site / "assets/icons/workload.svg").rename(site / "assets/icons/workload.svg.bak")
        await pg.reload(wait_until="networkidle"); await asyncio.sleep(5)
        await pg.reload(wait_until="networkidle")
        html = await pg.content()
        icon_ok = await pg.evaluate("fetch('assets/icons/workload.svg').then(r => r.ok)")
        check("新版有檔案下載失敗：繼續用完整的舊版，不會新舊混用", "新版一" in html and "新版三" not in html and icon_ok,
              f"仍是目前版本={'新版一' in html}、圖示仍在={icon_ok}")
        (site / "assets/icons/workload.svg.bak").rename(site / "assets/icons/workload.svg")
        st = await cache_state(pg)
        check("快取不會越積越多", len(st["keys"]) == 2, str(st["keys"]))

        if "--kiosk" in sys.argv:
            kiosk = await ctx.new_page()
            kiosk.on("pageerror", lambda e: errors.append(str(e)))
            await kiosk.goto(BASE, wait_until="networkidle")
            await asyncio.sleep(65)
            edit("js/app.js", "新版三", "新版四")
            t0 = time.time()
            ok = False
            while time.time() - t0 < 420:
                await asyncio.sleep(5)
                if "新版四" in await kiosk.content():
                    ok = True
                    break
            check("一直停在首頁、沒人碰的平板，會自己換成新版", ok, f"發布後 {round(time.time() - t0)} 秒")

        check("全程沒有瀏覽器錯誤", not errors, str(errors[:3]))
        await b.close()
    srv.shutdown()
    print("\n" + ("全部通過" if all(results) else "有項目未通過"))
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
