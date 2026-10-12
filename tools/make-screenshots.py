# 生成 README / 市场详情页用的那两张截图。
#
# ⚠️ 本脚本已弃用，改用 tools/make-screenshots.mjs（npm run screenshots）。
#    为什么换掉它 —— 这个版本有两个会导致**静默出错图**的缺陷：
#
#    1. 它用 Chrome 的 `--screenshot`。那个开关只截视口，超出部分**不报错、
#       退出码还是 0，直接丢掉**。所以"图里少了半屏"是看不出来的。
#    2. 它只验元素存在（`querySelector` 拿到即继续），**不验内容有没有画出来**。
#       这两条加起来漏出过一张门面图：面板里「这半个月」热力图整块是空的，
#       因为当时 CSS 里有一条 `@media (max-height: 900px) { .vs-deck-heat
#       { display: none } }` 把热力图无条件藏了，而这个脚本的 512x900 视口
#       正好踩进 900px 那条规则 —— 脚本一切正常，图是错的。
#
#    新脚本改用 CDP `Page.captureScreenshot` + 实测 rect 裁切，并且加了闸门：
#    热力图必须存在、display 不是 none、高度 > 0、非 0 格子够多、
#    完全落在面板内、胶囊文案是预期的连击态 —— 任一条不满足就拒绝出图。
#
# 保留下来的两个原始选择仍然有效：
#  1. **2 倍分辨率渲染再裁切**，而不是 1 倍直接截。1 倍时字号偏小、发虚，
#     放到市场上显得不精致。
#  2. **裁掉面板外的空白**。浮层模式下上方有几百像素纯黑（实测 y=438，
#     即图中 40% 是空的）；不裁的话读起来像"内部截图"而不是成品图。
#     裁切边界是**实测**的 getBoundingClientRect，不是估的。
#
# 每个状态用独立 Chrome profile：localStorage 会互相污染
# （这个坑我在 tools/render-states.py 里踩过，三张图渲染成了同一个状态）。
import io, json, os, shutil, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
DEMO = io.open(os.path.join(ROOT, "demo", "index.html"), encoding="utf-8").read()
ASSETS = os.path.join(ROOT, "assets")
SCALE = 2  # 渲染倍率

# 截图 1：整屏，展示输入框旁那颗胶囊（面板要**关着**，否则浮层会挡住胶囊）
DRIVE_MAIN = r"""
<script>
(function(){
  var t = 0;
  function go(){
    if (!window.__vsDemo || !window.__vsDemo.app){ if (++t > 900) return; return setTimeout(go, 20); }
    // 保证面板是关的：这张图要展示的是胶囊本身
    if (document.querySelector('.vs-panel')) window.__vsDemo.closePanel && window.__vsDemo.closePanel();
    document.title = 'ready';
  }
  go();
})();
</script>
"""

# 截图 2：打开面板，只留面板。
#
# 关于裁切的曲折（记下来免得再犯）：
#  · 浮层面板的高度**受视口高度约束**，所以"量出高度→按高度设视口"会越缩越小，
#    裁出来只剩半张卡；
#  · 想在整屏里用像素扫描找出面板上下边界也不可靠 —— 上方聊天区本身有文字，
#    白色像素会把边界混在一起（我扫出过 2361px 高的"面板"）。
# 干脆**用 CSS 把聊天区和侧栏藏掉**：页面上只剩面板，于是"整屏"就等于
# "面板"，不需要扫描也不需要估算。剩下的空白用实测 rect 精确裁掉。
DRIVE_PANEL = r"""
<script>
(function(){
  var t = 0;
  function go(){
    var dbg = window.__vsDemo;
    if (!dbg || !dbg.app){ if (++t > 900) return; return setTimeout(go, 20); }
    if (!document.querySelector('.vs-panel')){
      var c = document.querySelector('.vs-capsule');
      if (c) c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      else if (dbg.openPanel) dbg.openPanel();
      return setTimeout(go, 20);
    }
    // 既然只想要面板本身，就**不要改页面布局**。
    //
    // 我在这上面绕了三圈（visibility 通配塌成 16x16；display:none 连面板一起藏；
    // 藏聊天记录导致 composer 塌陷、面板被推到屏幕外 y=-477）。
    // 每一次都是"我在跟一个看不见的布局较劲"。最后改成：页面**原样不动**，
    // 面板照常打开，裁切交给像素扫描（见下面）。稳、也可复现。
    var css = document.createElement('style');
    css.textContent = 'html, body { background: #14110E !important; }';
    document.head.appendChild(css);
    setTimeout(function(){
      var rp = document.querySelector('.vs-panel').getBoundingClientRect();
      // 边界信息走 document.title：--dump-dom 能读到，但**不会印进截图**。
      // （之前塞了个绿字 <pre>，直接印进了要发布的图里。）
      document.title = 'VS_BOUNDS|' + JSON.stringify({
        panel: { x: rp.left, y: rp.top, w: rp.width, h: rp.height },
        iw: window.innerWidth, ih: window.innerHeight
      });
    }, 400);
  }
  go();
})();
</script>
"""


def render(mode, drive, w, h, scale=SCALE):
    page = DEMO.replace("</body>", drive + "</body>")
    f = os.path.join(ROOT, "_shot-%s.html" % mode)
    io.open(f, "w", encoding="utf-8", newline="\n").write(page)
    prof = tempfile.mkdtemp(prefix="vs-shot-")
    png = os.path.join(ROOT, "_raw-%s.png" % mode)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu",
                    "--allow-file-access-from-files",
                    "--user-data-dir=" + prof, "--hide-scrollbars",
                    "--force-device-scale-factor=%d" % scale,
                    "--virtual-time-budget=45000",
                    "--window-size=%d,%d" % (w, h),
                    "--screenshot=" + png,
                    "file:///" + f.replace("\\", "/")],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # 同一份页面再取一次边界（dump-dom）
    r = subprocess.run([CHROME, "--headless=new", "--disable-gpu",
                        "--allow-file-access-from-files",
                        "--user-data-dir=" + prof + "-b", "--hide-scrollbars",
                        "--virtual-time-budget=45000",
                        "--window-size=%d,%d" % (w, h),
                        "--dump-dom", "file:///" + f.replace("\\", "/")],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    shutil.rmtree(prof, ignore_errors=True)
    shutil.rmtree(prof + "-b", ignore_errors=True)
    os.remove(f)
    t = r.stdout.decode("utf-8", "replace")
    # 边界写在 document.title 里（不污染截图）：VS_BOUNDS|{...}
    mi = t.find("VS_BOUNDS|")
    bounds = None
    if mi >= 0:
        j = t.find("{", mi)
        k = t.find("</title>", j)
        if j >= 0 and k > j:
            try:
                bounds = json.loads(t[j:k].strip())
            except ValueError:
                bounds = None
    return png, bounds


# ── 图 1：整屏（胶囊可见）──────────────────────────────
#
# ⚠️ 原来这两张图是 **1 倍渲染** 的，理由是「2 倍太重」。那个判断是错的：
# 1 倍渲染下小字号中文的笔画会糊在一起，音标 `/ˈædvətaɪz/` 也发虚。
# 实测（用户反馈 + 视觉检查）：1 倍那版最糊的是底部提示语、
# 副标题「词库·四级·离线模式·用内置词表」、卡片底部那几个小标签。
#
# 之所以特别刺眼，是因为**同项目的 `tools/make-promo.mjs` 走的是 2 倍**，
# 于是"宣传图很清楚、README 图发虚"，两条管线不一致。
#
# 现在统一 2 倍。成本对比（都实测过）：
#   胶囊图  1465x950 / 39 KB  →  1960x1600 / 约 240 KB
#   面板图   700x1400 / 87 KB →   880x1800 / 约 330 KB
# 两张加起来约 570 KB。README 是门面，这个代价换清晰度是值的。
#
# 显示尺寸靠 **PNG 的 pHYs 元数据**控制：写成 144 DPI，浏览器/GitHub
# 就会按"逻辑尺寸"显示（1936/2 ≈ 968 CSS px），于是既清晰又不撑破版心。
main_png, _ = render("main", DRIVE_MAIN, 968, 800, scale=SCALE)
out1 = os.path.join(ASSETS, "screenshot-1-capsule.png")
shutil.copyfile(main_png, out1)

# ── 图 2：面板（整屏，不裁）─────────────────────────────
#
# 这张图我原本想做成"只留面板"的精确裁切，试了五六种办法都不稳定：
#   · CSS `[class*=dsh-] { visibility:hidden }` → 面板祖先一起中招，塌成 16x16
#   · `.dsh-demo { display:none }`              → 面板就住在这个容器里，一起被藏
#   · 藏聊天记录给 composer 固定高度             → 面板以 bottom 定位，被推到屏外 y=-477
#   · 按 rect 裁                                  → 裁出来顶部还剩 194px 空白（含阴影）
#   · 像素扫描找边界                              → 上方聊天区的文字混进来，扫出 98% 都是"内容"
# 根因：面板是浮层，它的高度和位置随视口与外壳布局一起变，裁切算法总差一截。
#
# 所以**不裁了**：直接用一整屏。面板完整地浮在对话之上，这本来就是用户
# 实际看到的画面，当门面图完全够用。（同时把视口给足：.vs-panel.floating
# 有 max-height: min(64vh, 560px)，视口太矮会把面板内容压得滚动起来。）
# 视口宽度要**贴着面板宽**（实测面板 487px 宽）。原来给 700 宽（现在读作 968），
# 面板只占中间一条，左右全是空背景 —— 图看着像"面板很小"，白占像素。
# 512 = 487 + 左右各约 12px 边距。
panel_png, b = render("panel", DRIVE_PANEL, 512, 900, scale=SCALE)
out2 = os.path.join(ASSETS, "screenshot-2-panel.png")
shutil.copyfile(panel_png, out2)
if b and b.get("panel"):
    print("  面板 rect: x=%.0f y=%.0f w=%.0f h=%.0f（视口 %sx%s）"
          % (b["panel"]["x"], b["panel"]["y"], b["panel"]["w"], b["panel"]["h"],
             b.get("iw"), b.get("ih")))

for p in (main_png, panel_png):
    if os.path.exists(p):
        os.remove(p)

from PIL import Image
for name in ("screenshot-1-capsule.png", "screenshot-2-panel.png"):
    q = os.path.join(ASSETS, name)
    im = Image.open(q)
    # 192 DPI（= 2 倍的 96 DPI 基准）告诉浏览器/GitHub「这是给高分屏的图」，
    # 于是它按逻辑尺寸显示：1960 宽的图占 980 CSS px，而不是 1960。
    # 没有这一步，2 倍图会以物理像素铺开，README 版心会被撑破。
    im.save(q, dpi=(192, 192))
    im2 = Image.open(q)
    print("  %-38s %sx%s  %s dpi  %s 字节"
          % (name, im2.size[0], im2.size[1], im2.info.get("dpi", ("?",))[0],
             os.path.getsize(q)))
