# 渲染三个状态并合成一张对比图，供人眼核对。
#
# 为什么留着它：这一轮我多次靠"自己渲染出来看"纠正判断
# （面板被挤成窄条、把"走完一轮"当成"有卡"）。测量数字能说"没有空洞"，
# 但说不了"好不好看"，那必须看图。
#
# 踩过的坑：三个状态最初是三个 iframe 并排加载同一份 demo。它们共用同一把
# localStorage 键，互相覆盖，于是三列渲染成同一个状态（还把我误导成"替换
# 没生效"，其实替换是对的）。现在每个状态**独立一个 Chrome 进程 + 独立
# user-data-dir**，存储天然隔离，再用 Pillow 横向拼图。
import io, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
DEMO = io.open(os.path.join(ROOT, "demo", "index.html"), encoding="utf-8").read()

W, H = 520, 1000
STATES = [("card", "开局"), ("done", "走完一轮"), ("allowed", "放行之后")]

DRIVE = r"""
<script>
(function(){
  var mode = '__MODE__';
  var tries = 0;
  function ready(cb){
    var dbg = window.__vsDemo;
    if (!dbg || !dbg.app){ if (++tries > 800) return; return setTimeout(function(){ ready(cb); }, 20); }
    if (!document.querySelector('.vs-panel')){
      var cap = document.querySelector('.vs-capsule');
      if (cap) cap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      else if (dbg.openPanel) dbg.openPanel();
      return setTimeout(function(){ ready(cb); }, 20);
    }
    cb(dbg.app);
  }
  function finish(app){
    var g = 0;
    while (g++ < 300 && !app.state.roundFinished){
      var b = document.querySelector('.vs-actions button');
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      else { app.rate('forgot'); app.next(); }
    }
  }
  ready(function(app){
    if (mode === 'done' || mode === 'allowed') finish(app);
    if (mode === 'allowed'){
      setTimeout(function(){ app.allowMoreNew(); }, 150);
    }
    setTimeout(function(){
      var d = document.createElement('pre');
      d.id = '__state';
      d.style.cssText = 'position:fixed;left:2px;bottom:2px;font:12px monospace;color:#9c9;z-index:99;margin:0';
      d.textContent = mode + ' | 今日=' + app.state.stats.todayAnswered +
        ' 走完=' + app.state.roundFinished +
        ' 卡=' + (app.state.card ? app.state.card.word.id : 'none') +
        ' 闸门关=' + (app.state.newGate ? app.state.newGate.closed : '?');
      document.body.appendChild(d);
    }, 700);
  });
})();
</script>
"""


def shot(mode):
    page = DEMO.replace("</body>", DRIVE.replace("__MODE__", mode) + "</body>")
    f = os.path.join(ROOT, "_one-%s.html" % mode)
    io.open(f, "w", encoding="utf-8", newline="\n").write(page)
    prof = tempfile.mkdtemp(prefix="vs-chrome-")
    png = os.path.join(ROOT, "_one-%s.png" % mode)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu",
                    "--allow-file-access-from-files",
                    "--user-data-dir=" + prof,
                    "--virtual-time-budget=45000",
                    "--window-size=%d,%d" % (W, H),
                    "--screenshot=" + png,
                    "file:///" + f.replace("\\", "/")],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(prof, ignore_errors=True)
    os.remove(f)
    if not os.path.exists(png):
        raise SystemExit("截图没生成: " + png)
    return png


shots = [(m, label, shot(m)) for m, label in STATES]

# 拼图：三张横排 + 顶部标签
try:
    from PIL import Image, ImageDraw
except ImportError:
    print("没有 Pillow，三张图分别如下：")
    for m, label, p in shots:
        print("  %-8s %s  %s" % (m, label, p))
    raise SystemExit(0)

pad, cap_h = 12, 26
Wt = pad + len(shots) * (W + pad)
Ht = cap_h + H + pad * 2
canvas = Image.new("RGB", (Wt, Ht), (14, 17, 22))
dr = ImageDraw.Draw(canvas)
for i, (m, label, p) in enumerate(shots):
    x = pad + i * (W + pad)
    dr.text((x + 2, 6), "%s · %s" % (m, label), fill=(139, 152, 165))
    canvas.paste(Image.open(p).convert("RGB"), (x, cap_h + pad))

out = os.path.join(ROOT, "_states.png")
canvas.save(out)
for _, _, p in shots:
    os.remove(p)
print("合成图:", out, os.path.getsize(out), "字节")
