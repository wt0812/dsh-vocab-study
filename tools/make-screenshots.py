# 生成 README / 市场详情页用的那两张截图。
#
# 为什么必须重新生成：assets/ 里原来那两张是**修布局之前**拍的
# （下面有半屏空洞、走完一轮只有「换词库」一个死角）。README 和市场详情页
# 都读同一份声明（screenshots.json），留着旧图就是在官方页面上展示旧界面。
#
# 做法上有两个刻意的选择：
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
# 1 倍渲染：这张是"整屏环境"照，2 倍会让它变成 2930x1900，放进 README 太重。
main_png, _ = render("main", DRIVE_MAIN, 1465, 950, scale=1)
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
panel_png, b = render("panel", DRIVE_PANEL, 700, 1400, scale=1)
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
    print("  %-38s %sx%s  %s 字节" % (name, im.size[0], im.size[1], os.path.getsize(q)))
