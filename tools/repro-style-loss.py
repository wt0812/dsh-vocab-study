# 复现「完成页出现巨大黑色圆形」并抓现场数据。
#
# 做法跟 tools/render-states.py 一样：把 demo/index.html 复制一份，
# 注入一段驱动脚本让它走到「走完一轮」状态，再用 Chrome headless 截图 + dump-dom。
# 额外做的事：把 .vs-ring 的尺寸/计算样式/样式表里有没有这条规则都打出来。
import io, os, re, shutil, subprocess, sys, tempfile

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
DEMO = io.open(os.path.join(ROOT, "demo", "index.html"), encoding="utf-8").read()
OUT = os.path.join(ROOT, os.environ.get("VS_REPRO_OUT", "_verify"))
os.makedirs(OUT, exist_ok=True)

W, H = int(sys.argv[1]) if len(sys.argv) > 1 else 883, int(sys.argv[2]) if len(sys.argv) > 2 else 1481

DRIVE = r"""
<script>
(function(){
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
    finish(app);
    setTimeout(function(){
      var out = { roundFinished: !!app.state.roundFinished, today: app.state.stats.todayAnswered };
      var rings = document.querySelectorAll('.vs-ring');
      out.ringCount = rings.length;
      if (rings.length){
        var r = rings[0], rc = r.getBoundingClientRect();
        var cs = getComputedStyle(r);
        out.ringRect = [Math.round(rc.width), Math.round(rc.height)];
        out.ringCss = { width: cs.width, height: cs.height, display: cs.display };
        var track = r.querySelector('.track');
        if (track){ var tcs = getComputedStyle(track); out.trackFill = tcs.fill; out.trackStroke = tcs.stroke; }
        var wrap = r.closest('.vs-ringwrap');
        if (wrap){ var wcs = getComputedStyle(wrap); out.wrapCss = { width: wcs.width, height: wcs.height }; }
      }
      var st = document.querySelector('style[data-vocab-study]');
      out.styleLen = st ? st.textContent.length : 0;
      out.styleHasRingRule = st ? /\.vs-ring\s*\{/.test(st.textContent) : null;
      // 样式表里到底有没有被解析出来的 .vs-ring 规则
      out.cssRulesWithRing = 0;
      try {
        for (var i = 0; i < document.styleSheets.length; i++){
          var rules = document.styleSheets[i].cssRules || [];
          for (var j = 0; j < rules.length; j++){
            if (rules[j].selectorText && rules[j].selectorText.indexOf('vs-ring') >= 0){
              out.cssRulesWithRing++;
              if (!out.ringRuleText) out.ringRuleText = rules[j].cssText.slice(0, 160);
            }
          }
        }
      } catch(e){ out.cssScanError = String(e); }
      // 实验：把插件自己的样式表关掉，看是不是只剩「样式没上」才会炸
      if (window.__NOCSS__) {
        try {
          for (var s = 0; s < document.styleSheets.length; s++){
            var sh = document.styleSheets[s], hit = false;
            var rr = sh.cssRules || [];
            for (var q = 0; q < rr.length; q++){
              if (rr[q].selectorText && rr[q].selectorText.indexOf('vs-') >= 0){ hit = true; break; }
            }
            if (hit) { sh.disabled = true; out.disabledSheet = (out.disabledSheet || 0) + 1; }
          }
          if (document.adoptedStyleSheets && document.adoptedStyleSheets.length){
            document.adoptedStyleSheets = [];
            out.clearedAdopted = true;
          }
        } catch(e){ out.disableError = String(e); }
      }
      var pre = document.createElement('pre');
      pre.id = '__diag';
      pre.textContent = JSON.stringify(out);
      document.body.appendChild(pre);
    }, 900);
  });
})();
</script>
"""

NOCSS = "--nocss" in sys.argv
page = DEMO.replace("</body>", ("<script>window.__NOCSS__=true;</script>" if NOCSS else "") + DRIVE + "</body>")
html = os.path.join(OUT, "_repro-done.html")
io.open(html, "w", encoding="utf-8", newline="\n").write(page)

prof = tempfile.mkdtemp(prefix="vs-chrome-")
png = os.path.join(OUT, "repro-done%s.png" % ("-nocss" if NOCSS else ""))
r = subprocess.run(
    [CHROME, "--headless=new", "--disable-gpu", "--allow-file-access-from-files",
     "--user-data-dir=" + prof, "--virtual-time-budget=45000",
     "--window-size=%d,%d" % (W, H),
     "--screenshot=" + png, "--dump-dom",
     "file:///" + html.replace("\\", "/")],
    capture_output=True, text=True, encoding="utf-8", errors="replace",
)
shutil.rmtree(prof, ignore_errors=True)

m = re.search(r'<pre id="__diag">(.*?)</pre>', r.stdout, re.S)
print("=== 诊断 ===")
print(m.group(1) if m else "（没拿到 __diag；stdout 长度 %d）" % len(r.stdout))
print("=== 截图 ===", png, os.path.getsize(png) if os.path.exists(png) else "没生成")
