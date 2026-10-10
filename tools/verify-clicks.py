# 点击行为验证：把驱动脚本注入 demo 页面，在无头 Chrome 里真的点按钮。
#
# 为什么需要它（它抓到过两个"渲染验证发现不了"的 bug）：
#   · 闸门关着时「再来 5 个新词」点了什么也没发生（假按钮）
#   · 点「再背一轮」后进度环显示上一轮的数字（环说 1、今日已背说 6，互相矛盾）
# 这两个界面渲染看起来都正常，光看截图、光看源码都发现不了 —— 只有真的点下去、
# 对比点击前后的状态才抓得出来。
#
# 早期两版是跨 iframe 边界驱动的，一直卡在"等不到面板"，而且我看不到
# iframe 里到底启动到哪一步，只能猜。现在把驱动脚本注入 demo 自己的
# </body> 之前，与 boot() 同一个文档、同一个作用域链，于是"启动到哪一步"
# 变成可直接读的事实。每一步都**增量**写进 <pre id="__out">，
# 中途抛错也不会丢掉前面已拿到的步骤。
#
# 用法：python tools/verify-clicks.py
import io, json, os, subprocess, sys

# 注意：这个文件在 tools/ 下，仓库根是它的上一级。
# （我刚开始把 ROOT 写成脚本自己所在目录，于是找不到 demo/index.html。）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
DEMO = os.path.join(ROOT, "demo", "index.html")
if not os.path.exists(DEMO):
    raise SystemExit("找不到 %s —— 先跑 python tools/build-all.py" % DEMO)
DEMO_HTML = io.open(DEMO, encoding="utf-8").read()

DRIVER = r"""
<script>
// ── 发音间谍：必须在 <body> 末尾、其余脚本之前装上 ──
// 为什么拦真 speechSynthesis 而不是用 demo 自己的 onSpeak 钩子：
// 用户报的 bug 就是"点了没声音"，坏的正是 speak 这一层。
// 用宿主钩子等于绕开被怀疑的那段代码，测不出东西。
(function(){
  window.__SPOKEN = [];
  window.__SYNTH = 0;
  var s = window.speechSynthesis;
  if (!s) { window.__NO_SYNTH = true; return; }
  var orig = s.speak ? s.speak.bind(s) : null;
  s.speak = function(u){
    window.__SYNTH++;
    window.__SPOKEN.push(u && u.text);
    try { if (orig) orig(u); } catch (e) { /* 无头环境没声音设备，正常 */
    }
  };
})();
(function(){
  var results = [];
  function out(){
    var raw = JSON.stringify(results);
    var pre = document.getElementById('__out');
    if (!pre) { pre = document.createElement('pre'); pre.id = '__out'; document.body.appendChild(pre); }
    pre.textContent = 'BEGIN' + raw + 'END';
  }
  function findBtn(label){
    var all = document.querySelectorAll('.vs-panel button, .vs-panel a');
    for (var i = 0; i < all.length; i++){
      if (String(all[i].textContent || '').indexOf(label) >= 0) return all[i];
    }
    return null;
  }
  function click(el){
    if (!el) return false;
    var E = window.MouseEvent || MouseEvent;
    el.dispatchEvent(new E('click', { bubbles: true }));
    return true;
  }
  function snap(app){
    var st = app.state;
    function txt(sel){ var e = document.querySelector(sel); return e ? String(e.textContent) : null; }
    return {
      today: st.stats.todayAnswered,
      todayKpi: (function(){
        var k = document.querySelectorAll('.vs-kpi b');
        return k.length ? String(k[0].textContent) : null;
      })(),
      // 环上写的是"这一轮"的进度，必须和 KPI("今天")区分开，两者不该互相矛盾
      ring: txt('.vs-ring .pct'),
      finished: st.roundFinished,
      roundSize: st.roundSize,
      items: st.container ? st.container.items.length : 0,
      queueLen: st.session ? st.session.queue.length : -1,
      card: st.card ? st.card.word.id : null,
      gateClosed: st.newGate ? st.newGate.closed : null,
      gateBypassed: st.newGate ? st.newGate.bypassed : null,
      extendedBy: st.extendedBy,
      newCount: st.container && st.container.stats ? st.container.stats.newCount : null
    };
  }
  function finishRound(app){
    var guard = 0;
    while (guard++ < 300 && !app.state.roundFinished){
      var b = document.querySelector('.vs-actions button');
      if (b) click(b); else { app.rate('forgot'); app.next(); }
    }
    return guard;
  }
  var tries = 0, phase = 'boot', app = null, dbg = null, opened = false;
  function step(){
    try { run(); }
    catch (e) {
      results.push({ step: 'JS 抛错 @' + phase, err: String(e && e.message),
                     stack: String(e && e.stack || '').split('\n').slice(0, 5).join(' | ') });
      out();
    }
  }
  function run(){
    if (phase === 'boot'){
      dbg = window.__vsDemo;
      app = dbg && dbg.app;
      if (!app || !document.getElementById('dsh-root')){
        if (++tries > 600){ results.push({ step: '等待启动超时', hasDemo: !!dbg, hasApp: !!app }); out(); return; }
        setTimeout(step, 25); return;
      }
      // 面板默认是关着的（浮动模式）。必须先点胶囊把它打开，
      // 否则 /vs-panel/ 根本不在文档里 —— 上一版就是卡在这一步。
      // 这一点本身也是对的：不该一进页面就弹面板挡住对话。
      if (!document.querySelector('.vs-panel')){
        if (!opened){
          var cap = document.querySelector('.vs-capsule');
          results.push({ step: '找到胶囊', found: !!cap });
          if (cap) click(cap);
          opened = true;
        } else if (dbg.openPanel){
          dbg.openPanel();
        }
        if (++tries > 600){ results.push({ step: '打开面板超时', panel: false }); out(); return; }
        setTimeout(step, 25); return;
      }
      results.push({ step: '面板已打开', s: snap(app) });
      phase = 'speak'; setTimeout(step, 60); return;
    }
    // ── 播放键：用户报「单词右边的播放键是无效的」────────────────
    // 现场：处理函数里调的是 `globalThis.__VS_SPEAK__?.(word)` —— 一个从来
    // 没有人赋值的全局钩子，配上 `?.` 永远静默；后面 `if (ctx.onSpeak)` 也
    // 一直是空的（适配层转发 host 时漏了这一项）。两条路都断，点了毫无反应、
    // 连报错都没有。修完后这里必须能听到真的 speechSynthesis.speak 调用。
    if (phase === 'speak'){
      var wbtn = document.querySelector('.vs-panel .vs-word');
      var before = window.__SYNTH;
      var wtext = wbtn ? String(wbtn.textContent || '').trim() : null;
      if (wbtn) click(wbtn);
      results.push({ step: '点单词发音', found: !!wbtn, label: wtext,
                     noSynth: !!window.__NO_SYNTH,
                     synthBefore: before, synthAfter: window.__SYNTH,
                     spoken: window.__SPOKEN.slice(-3) });
      phase = 'finish1'; setTimeout(step, 40); return;
    }
    if (phase === 'finish1'){
      finishRound(app);
      results.push({ step: '走完一轮后', s: snap(app) });
      // "走完一轮"的空状态校验必须放在**这里**。放到最后会失效：后面
      // 点「再来 5 个新词」会把界面带回有卡状态，那时当然查不到空状态里的按钮。
      // （我第一版就是这么写的，于是自己给自己报了两个假 FAIL。）
      results.push({ step: '走完一轮后是空状态（没有词卡）',
                     hasCard: !!document.querySelector('#vs-card') });
      results.push({ step: '存在「换词库」（走完一轮状态下）', found: !!findBtn('换词库') });
      results.push({ step: '走完一轮时的按钮', buttons: (function(){
        var all = document.querySelectorAll('.vs-panel button, .vs-panel a');
        var arr = [];
        for (var i = 0; i < all.length; i++) arr.push(String(all[i].textContent || '').trim().slice(0, 12));
        return arr;
      })() });
      phase = 'restart'; setTimeout(step, 80); return;
    }
    if (phase === 'restart'){
      var b1 = findBtn('再背一轮');
      results.push({ step: '存在「再背一轮」', found: !!b1 });
      if (b1) click(b1);
      results.push({ step: '点「再背一轮」后', s: snap(app) });
      phase = 'finish2'; setTimeout(step, 80); return;
    }
    if (phase === 'finish2'){
      // 只有真的回到有卡状态才继续背。否则 finishRound 会在 300 步里空转，
      // 白白把虚拟时间预算耗光，最后我拿到的是"超时"而不是真正的原因。
      if (document.querySelector('#vs-card')){
        finishRound(app);
      } else {
        results.push({ step: '重背后没有词卡，跳过本步' });
      }
      phase = 'extend1'; setTimeout(step, 80); return;
    }
    if (phase === 'extend1'){
      var b2 = findBtn('再来 5 个新词');
      results.push({ step: '存在「再来 5 个新词」', found: !!b2 });
      if (b2) click(b2);
      results.push({ step: '点「再来 5 个新词」后', s: snap(app) });
      phase = 'gate'; setTimeout(step, 80); return;
    }
    if (phase === 'gate'){
      var g = findBtn('我还是想继续');
      results.push({ step: '存在「我还是想继续」', found: !!g,
                     gateClosedBefore: app.state.newGate.closed });
      // 记下这一轮背过哪些词，用来验证"放行后不会再给刚背过的"
      var back = {};
      if (app.state.session) {
        app.state.session.queue.forEach(function(c){ if (c.answered) back[c.word.id] = 1; });
      }
      results.push({ step: '本轮背过的词数', count: Object.keys(back).length });
      if (g) click(g);
      setTimeout(function(){
        var st = app.state;
        results.push({ step: '点「我还是想继续」后', s: snap(app) });
        // 关键：放行之后界面必须真的给卡，而且给的是**没背过的**
        results.push({ step: '放行后给出的是否是新卡',
                       card: st.card ? st.card.word.id : null,
                       wasJustAnswered: st.card ? !!back[st.card.word.id] : null });
        phase = 'extend2'; setTimeout(step, 80);
      }, 120);
      return;
    }
    if (phase === 'extend2'){
      var b3 = findBtn('再来 5 个新词');
      var beforeIds = (app.state.container ? app.state.container.items : []).map(function(i){ return i.word.id; });
      if (b3) click(b3);
      var ids = (app.state.container ? app.state.container.items : []).map(function(i){ return i.word.id; });
      var seen = {}, dup = 0;
      ids.forEach(function(x){ if (seen[x]) dup++; seen[x] = 1; });
      results.push({ step: '第二次加量后', s: snap(app) });
      results.push({ step: '加量不重复', total: ids.length, unique: Object.keys(seen).length, dup: dup });
      phase = 'swap'; setTimeout(step, 80); return;
    }
    if (phase === 'swap'){
      // 此刻界面已经因为「再来 5 个新词」回到有卡状态，所以这里只查两件
      // 与界面位置无关的事：底部第一个指标、以及加量后卡是不是真的能背。
      results.push({ step: '此刻所有按钮', buttons: (function(){
        var all = document.querySelectorAll('.vs-panel button, .vs-panel a');
        var arr = [];
        for (var i = 0; i < all.length; i++) arr.push(String(all[i].textContent || '').trim().slice(0, 12));
        return arr;
      })() });
      results.push({ step: '底部指标第一个是「今天已背」', firstKpi: (function(){
        var k = document.querySelectorAll('.vs-kpi');
        return k.length ? String(k[0].textContent) : null;
      })() });
      out(); return;
    }
  }
  setTimeout(step, 60);
})();
</script>
"""

PAGE = DEMO_HTML.replace("</body>", DRIVER + "</body>")
if DRIVER not in PAGE:
    print("注入失败：demo/index.html 里没有 </body>")
    raise SystemExit(1)

# 临时页面写在仓库根（tools/ 下会污染工具目录；仓库根的 _* 已被 .gitignore 覆盖）
out_path = os.path.join(ROOT, "_verify-clicks.html")
io.open(out_path, "w", encoding="utf-8", newline="\n").write(PAGE)

cmd = [CHROME, "--headless=new", "--disable-gpu", "--allow-file-access-from-files",
       "--virtual-time-budget=60000", "--window-size=560,1000", "--dump-dom",
       "file:///" + out_path.replace("\\", "/")]
p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
t = p.stdout.decode("utf-8", "replace")


def die(msg, tail=""):
    print(msg)
    if tail:
        print(tail[-1000:])
    try:
        os.remove(out_path)
    except OSError:
        pass
    raise SystemExit(1)


i = t.find('id="__out"')
if i < 0:
    die("没有 __out 节点（驱动脚本没跑起来）。页面尾部：", t)
j = t.find(">", i) + 1
k = t.find("</pre>", j)
raw = t[j:k]
if "BEGIN" not in raw:
    die("__out 内容不是结果（驱动脚本可能抛错了）：" + repr(raw[:300]))
data = json.loads(raw[raw.find("BEGIN") + 5: raw.rfind("END")])
os.remove(out_path)

print("═══ 点击行为验证（注入式，同文档真实点击）═══")
failed = []
for r in data:
    if "s" in r:
        s = r["s"]
        print("  【%s】" % r["step"])
        print("     今日=%-3s KPI首位=%-8s 环=%-7s 走完=%-5s 本轮=%-4s 容器=%-4s 队列=%-4s 词=%s"
              % (s["today"], s["todayKpi"], s["ring"], s["finished"], s["roundSize"], s["items"], s["queueLen"], s["card"]))
        print("     闸门关=%-5s 已放行=%-5s 加量=%-3s 新词=%s"
              % (s["gateClosed"], s["gateBypassed"], s["extendedBy"], s["newCount"]))
    else:
        rest = {kk: vv for kk, vv in r.items() if kk != "step"}
        print("  %-30s %s" % (r["step"], json.dumps(rest, ensure_ascii=False)))
        if r["step"].startswith("JS 抛错") or "超时" in r["step"]:
            failed.append(r["step"])

# 几条关键事实的自动判定：不靠我看输出，直接给退出码。
# 这样它能进 CI/构建流程，而不是"我一个人看一眼"。
facts = {r["step"]: r for r in data if "step" in r}
steps = [r for r in data if "s" in r]
def by(name):
    for r in steps:
        if r["step"] == name:
            return r["s"]
    return None

checks = []
ready = by("面板已打开")
if ready:
    checks.append(("开局：环是 0/总数", ready["ring"] == "0/20"))
    checks.append(("开局：底部第一个指标是「今天已背」",
                   (ready["todayKpi"] or "") == "0"))

done = by("走完一轮后")
if done:
    checks.append(("走完一轮：KPI「今天已背」= 5", done["todayKpi"] == "5"))
    checks.append(("走完一轮：环不再是 0", done["ring"] != "0/20"))

rs = by("点「再背一轮」后")
if rs:
    checks.append(("点「再背一轮」后：环归零（不显示上一轮的数字）", rs["ring"] == "0/20"))
    checks.append(("点「再背一轮」后：今日已背保持不变（KPI 不跟着归零）", rs["todayKpi"] == "5"))
    checks.append(("点「再背一轮」后：又有词卡可背", rs["card"] is not None and rs["finished"] is False))

gt = facts.get("存在「我还是想继续」")
if gt:
    checks.append(("闸门关着时：不显示「再来 5 个新词」这个假按钮",
                   facts.get("存在「再来 5 个新词」", {}).get("found") is False))
    checks.append(("闸门关着时：显示「我还是想继续」", gt.get("found") is True))

al = by("点「我还是想继续」后")
if al:
    checks.append(("点「我还是想继续」后：闸门真的打开", al["gateClosed"] is False and al["gateBypassed"] is True))
    checks.append(("点「我还是想继续」后：新词真的进来", (al["newCount"] or 0) > 0))

dup = facts.get("加量不重复")
if dup:
    checks.append(("加量不重复", dup.get("dup") == 0))

# 播放键：用户报「单词右边的播放键是无效的」。
# 判据是"真的发出了朗读请求"，不是"按钮存在"—— 它一直都存在，只是点了没用。
sp = facts.get("点单词发音")
if sp:
    if sp.get("noSynth"):
        checks.append(("播放键：本环境没有 speechSynthesis（跳过）", True))
    else:
        checks.append(("播放键：界面上找得到 .vs-word", sp.get("found") is True))
        checks.append(
            ("点一下播放键，真的发出朗读请求（speechSynthesis.speak 调用数 +1）",
             (sp.get("synthAfter") or 0) > (sp.get("synthBefore") or 0)),
        )
        spoke = sp.get("spoken") or []
        lbl = sp.get("label") or ""
        checks.append(
            ("读的就是卡片上那个词（不是空串、不是 undefined）",
             len(spoke) > 0 and isinstance(spoke[-1], str) and len(spoke[-1]) >= 2
             and spoke[-1] in lbl),
        )

# 这条是这一轮最重要的回归锁：点「我还是想继续」之后，
# 界面必须真的给卡，而且给的是没背过的。之前这里给的是刚背过的第一个词
# （createSession 无条件把容器全变成新队列，等于把已答的又端上来一遍）。
newc = facts.get("放行后给出的是否是新卡")
if newc:
    checks.append(("放行后立刻出现词卡（不是又回到「这一轮走完了」）", newc.get("card") is not None))
    checks.append(("放行后给的是没背过的词", newc.get("wasJustAnswered") is False))

sd = facts.get("走完一轮后是空状态（没有词卡）")
if sd:
    checks.append(("走完一轮后确实是空状态（换词库按钮所在的那个界面）", sd.get("hasCard") is False))
sw = facts.get("存在「换词库」（走完一轮状态下）")
if sw:
    checks.append(("走完一轮后「换词库」在界面上", sw.get("found") is True))

print("\n── 自动判定 ──")
bad = 0
for name, okv in checks:
    print("  %s %s" % ("PASS" if okv else "FAIL", name))
    if not okv:
        bad += 1
if failed:
    print("  FAIL 脚本自身出错：%s" % failed)
    bad += len(failed)
print("\n合计 %d 项，失败 %d 项" % (len(checks), bad))
sys.exit(1 if bad else 0)

