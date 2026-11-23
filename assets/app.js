/* ================= 接单快算 v6 =================
   主线：粘一单 → 立刻知道挣多少 → 一键复制报价/回电话术 → 记进账本
   没有假数据、不连平台接口、不碰账号。所有单子都来自爸爸自己复制进来的文本。
   ---------------------------------------------------------------
   依赖：assets/parse.js（window.TruckParse）
   存储：localStorage["truckv6.v1"]
   ================================================================ */
(function () {
  "use strict";

  var TP = window.TruckParse;
  var $ = function (id) { return document.getElementById(id); };
  var KEY = "truckv6.v1";
  var LEGACY = ["truckAgg.v1", "truckLedger.v1"];

  var DEFAULTS = {
    fuel: 30,          // 升/百公里
    price: 7.6,        // 元/升
    speed: 55,         // 平均时速
    target: 45,        // 目标时薪
    fixed: 0,          // 每趟固定成本（保险/折旧分摊）
    home: "",          // 我现在在哪 —— 不预设，必须是定位或用户自己填（v7 修）
    comeBack: true,    // 默认扣返程空驶
    staleMin: 8,       // 多久没更新标灰
    mapOn: true,       // 是否自动加载地图（省流量，可在设置关掉）
    amapKey: "92f7745dba3d8592d9a5d21691c38abd",
    amapSec: "74bc3446ff478240796f2aaa0b8862ba"
  };

  var S = assign({}, DEFAULTS);
  var pool = [];       // 所有贴进来的单（按指纹去重）
  var ledger = [];     // 记下的单（跑完的真实收入）
  var cur = null;      // 当前正在算的单（parse 结果）
  var lastBid = 0;
  var mapLast = null;  // 地图单独算的那份（起点/终点/空驶/里程/过路），跟粘贴那套互不影响

  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (!s) continue;
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }

  /* ---------------- 存储 ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var d = JSON.parse(raw);
        S = assign({}, DEFAULTS, d.settings || {});
        pool = Array.isArray(d.pool) ? d.pool : [];
        ledger = Array.isArray(d.ledger) ? d.ledger : [];
        return;
      }
      // 从 v5 迁移一次：它里面有真实的记账
      for (var i = 0; i < LEGACY.length; i++) {
        var old = localStorage.getItem(LEGACY[i]);
        if (!old) continue;
        var o = JSON.parse(old);
        if (o && o.settings) {
          S = assign(S, {
            fuel: num(o.settings.fuel) || S.fuel,
            price: num(o.settings.price) || S.price,
            speed: num(o.settings.speed) || S.speed,
            target: num(o.settings.target) || S.target,
            fixed: num(o.settings.fixed) || 0,
            amapKey: o.settings.amapKey || S.amapKey,
            amapSec: o.settings.amapSec || S.amapSec
          });
        }
        if (o && Array.isArray(o.ledger) && o.ledger.length) { ledger = o.ledger; }
        else if (o && Array.isArray(o.orders) && o.orders.length) { ledger = o.orders; }
        if (ledger.length) break;
      }
    } catch (e) {}
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ settings: S, pool: pool, ledger: ledger }));
    } catch (e) {}
  }

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) {
    var x = parseFloat(String(v == null ? "" : v).replace(/,/g, "."));
    return isFinite(x) && x > 0 ? x : 0;
  }
  function fmt(n, d) {
    if (n == null || !isFinite(n)) return "—";
    d = d == null ? 0 : d;
    return Number(n).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + "秒前";
    if (s < 3600) return Math.round(s / 60) + "分钟前";
    if (s < 86400) return Math.round(s / 3600) + "小时前";
    return Math.round(s / 86400) + "天前";
  }
  var toastT = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove("show"); }, 2000);
  }
  function copy(text) {
    return new Promise(function (res) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { res(true); }, function () { res(fallback(text)); });
      } else res(fallback(text));
    });
    function fallback(t) {
      try {
        var ta = document.createElement("textarea");
        ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }
  }

  /* =========================================================
     一、算账内核（跟爸爸原来那张表的口径保持一致）
     ========================================================= */
  function calc(o, a) {
    a = a || {};
    var fuel = num(a.fuel) || S.fuel;
    var price = num(a.price) || S.price;
    var speed = num(a.speed) || S.speed;
    var fixed = a.fixed != null ? num(a.fixed) : S.fixed;
    var back = a.comeBack != null ? !!a.comeBack : !!S.comeBack;

    var km = num(o.km), dead = num(o.dead), wait = num(o.wait);
    var freight = num(o.freight), toll = num(o.toll), other = 0;
    var oneway = km + dead;                     // 去程总行驶
    var totalDriven = back ? oneway * 2 : oneway; // 算返程时的总行驶
    var fuelCost = totalDriven / 100 * fuel * price;
    var cost = fuelCost + toll + other + fixed;
    var net = freight - cost;
    var hrs = (speed > 0 ? totalDriven / speed : 0) + wait;
    var kmLoaded = km > 0 ? km : oneway;         // 没填载货里程就按行驶里程
    return {
      freight: freight, km: km, dead: dead, wait: wait, toll: toll,
      oneway: oneway, totalDriven: totalDriven, back: back,
      fuel: fuelCost, tollSum: toll + other + fixed, cost: cost, net: net,
      hrs: hrs, perKm: totalDriven > 0 ? net / totalDriven : null,
      hourly: hrs > 0 ? net / hrs : null,
      // 保本价：一毛不挣的运费
      breakeven: Math.round((cost) / 10) * 10,
      // 报价起点：达到目标时薪
      bid: Math.round((cost + S.target * Math.max(hrs, 0.1)) / 10) * 10
    };
  }

  /* =========================================================
     二、粘贴解析 → 当前单
     ========================================================= */
  function setCurrent(o, opts) {
    opts = opts || {};
    if (!o) { toast("这段文字没认出来地名或运费"); return; }
    cur = o;
    cur.cargo = cur.cargo || "";
    $("qpFreight").value = o.freight || "";
    $("qpKm").value = o.km || "";
    $("qpDead").value = o.dead || "";
    $("qpWait").value = o.wait || "";
    $("qpToll").value = o.toll || "";
    $("qpFrom").value = o.from || "";
    $("qpTo").value = o.to || "";
    $("qpCargo").value = [o.cargo, o.goods, o.weight].filter(Boolean).join(" ");
    renderQuick();
    if (!opts.silent) {
      var miss = [];
      if (!o.freight) miss.push("运费");
      if (!o.km) miss.push("公里数");
      if (!o.from) miss.push("起点");
      toast(miss.length ? "认出来了，" + miss.join("、") + " 请手填" : "认出来了 ✓");
    }
  }

  function fromInputs() {
    return {
      from: $("qpFrom").value.trim(),
      to: $("qpTo").value.trim(),
      freight: num($("qpFreight").value),
      km: num($("qpKm").value),
      dead: num($("qpDead").value),
      wait: num($("qpWait").value),
      toll: num($("qpToll").value),
      cargo: $("qpCargo").value.trim(),
      rawLines: cur && cur.rawLines || []
    };
  }

  /* =========================================================
     三、渲染：单子速算卡
     ========================================================= */
  function verdictOf(c) {
    if (!c.freight || !c.totalDriven) return { cls: "", text: "填完运费和里程就算出来" };
    if (c.net <= 0) return { cls: "bad", text: "倒贴，别接" };
    if (c.hourly == null) return { cls: "warn", text: "算得出净赚，缺时速" };
    if (c.hourly >= S.target) return { cls: "ok", text: "能跑，时薪够" };
    if (c.hourly >= S.target * 0.7) return { cls: "warn", text: "勉强，看顺不顺路" };
    return { cls: "bad", text: "太便宜，别接" };
  }

  function renderQuick() {
    var o = fromInputs();
    var c = calc(o);
    cur && (cur._c = c);

    var v = verdictOf(c);
    var vd = $("qVerdict");
    vd.className = "verdict" + (v.cls ? " " + v.cls : "");
    vd.textContent = v.text;

    $("qNet").textContent = c.freight ? fmt(c.net, 0) : "0";
    $("qBigRow").className = "big" + (c.net < 0 ? " neg" : "");
    $("qHourly").textContent = c.hourly == null ? "—" : "¥" + fmt(c.hourly, 0);
    $("qPerKm").textContent = c.perKm == null ? "—" : "¥" + fmt(c.perKm, 2);
    $("qHours").textContent = c.hrs > 0 ? fmt(c.hrs, 1) + "h" : "—";
    $("qBreakeven").textContent = "¥" + fmt(c.breakeven, 0);
    $("qBid").textContent = "¥" + fmt(c.bid, 0);

    var bits = [];
    if (c.totalDriven > 0) bits.push("跑 " + fmt(c.totalDriven, 0) + " 公里" + (c.back ? "（含返程）" : ""));
    if (c.fuel > 0) bits.push("油钱 ¥" + fmt(c.fuel, 0));
    if (c.toll > 0) bits.push("过路 ¥" + fmt(c.toll, 0));
    if (S.fixed > 0) bits.push("固定成本 ¥" + fmt(S.fixed, 0));
    if (c.wait > 0) bits.push("等 " + fmt(c.wait, 1) + " 小时");
    $("qBreak").textContent = bits.join("　·　") || "——";

    // 倒贴时给出"不扣返程"的对照，这是跑长途最常见的选择依据
    var c2 = calc(o, { comeBack: false });
    var hint = $("qBackHint");
    var showHint = c.back && c.net < 0 && c2.net > 0;
    hint.hidden = !showHint;
    if (showHint) {
      hint.innerHTML = "⚠ 扣了返程油钱是亏的。<b>如果回程能配到货</b>，只算去程这趟是净赚 ¥" +
        fmt(c2.net, 0) + "，时薪 ¥" + fmt(c2.hourly == null ? 0 : c2.hourly, 0) + "。跑长途记得先看有没有回程货。";
    }

    $("qCopyBid").textContent = "复制报价 ¥" + fmt(c.bid, 0);
    lastBid = c.bid;
  }

  /* =========================================================
     四、单池（贴过的每一单都在这里，按收益排序看哪单好）
     ========================================================= */
  function visiblePool() {
    var sort = $("poolSort").value;
    var hideBad = $("poolHideBad").checked;
    var kw = ($("poolKeyword").value || "").trim();
    var out = pool.map(function (o) {
      var c = calc(o);
      return { o: o, c: c };
    });
    out = out.filter(function (x) {
      if (hideBad && (x.c.net <= 0 || (x.c.hourly != null && x.c.hourly < S.target * 0.7))) return false;
      if (kw) {
        var s = (x.o.from || "") + (x.o.to || "") + (x.o.cargo || "") + (x.o.goods || "");
        if (s.indexOf(kw) < 0) return false;
      }
      return true;
    });
    out.sort(function (a, b) {
      if (sort === "hourly") return (b.c.hourly || -1e9) - (a.c.hourly || -1e9);
      if (sort === "net") return b.c.net - a.c.net;
      if (sort === "perKm") return (b.c.perKm || -1e9) - (a.c.perKm || -1e9);
      if (sort === "freight") return b.o.freight - a.o.freight;
      if (sort === "km") return b.o.km - a.o.km;
      return b.ts - a.ts; // fresh
    });
    return out;
  }

  function renderPool() {
    var list = visiblePool();
    $("poolCount").textContent = pool.length ? list.length + " / " + pool.length + " 单" : "";
    if (!pool.length) {
      $("poolList").innerHTML =
        '<div class="empty">还没贴过单。<br />哪个 App 都行——货拉拉、运满满、满帮、滴滴货运、快狗、省省回头车……<br />长按那一单的文字复制，回来点上面的大按钮。</div>';
      return;
    }
    if (!list.length) {
      $("poolList").innerHTML = '<div class="empty">这些单都被筛掉了。<br />把「只看能跑的」关掉看看。</div>';
      return;
    }
    $("poolList").innerHTML = list.map(function (x, i) {
      var o = x.o, c = x.c;
      var v = verdictOf(c);
      return '<article class="ord ' + (c.net <= 0 ? "bad" : "") + '" data-id="' + esc(o.id) + '">' +
        '<div class="ohead">' +
        '<span class="rank">' + (i + 1) + "</span>" +
        '<span class="tag" style="--pc:#0f766e">' + (o.source ? esc(o.source) : "粘贴") + "</span>" +
        (v.cls === "ok" ? '<span class="tag auto">能跑</span>' : "") +
        '<span class="ofresh">' + ago(o.ts) + "</span>" +
        "</div>" +
        '<div class="oroute"><span>' + esc(o.from || "？") + "</span><b>→</b><span>" + esc(o.to || "？") + "</span></div>" +
        '<div class="ometa">' +
        (o.km ? esc(o.km) + " 公里" : '<i class="warnText">缺公里数</i>') +
        (o.dead ? " · 空驶 " + esc(o.dead) + "km" : "") +
        (o.cargo || o.goods ? " · " + esc([o.cargo, o.goods].filter(Boolean).join(" ")) : "") +
        (o.loadTime ? " · " + esc(o.loadTime) : "") +
        "</div>" +
        '<div class="omoney">' +
        '<div class="om-main"><span>¥</span><b>' + fmt(o.freight, 0) + "</b><i>运费</i></div>" +
        '<div class="om-sub"><b class="' + (c.net >= 0 ? "green" : "red") + '">' +
        (c.net >= 0 ? "净赚 ¥" + fmt(c.net, 0) : "净亏 ¥" + fmt(-c.net, 0)) + "</b>" +
        "<i>" + (c.hourly == null ? "时薪 —" : "时薪 ¥" + fmt(c.hourly, 0)) +
        (c.perKm == null ? "" : " · ¥" + fmt(c.perKm, 2) + "/公里") + "</i></div>" +
        "</div>" +
        '<div class="obtns">' +
        '<button class="btn sm primary" data-act="open">算这单</button>' +
        '<button class="btn sm" data-act="copy">复制报价</button>' +
        '<button class="btn sm ghost" data-act="del" title="删掉">×</button>' +
        "</div>" +
        "</article>";
    }).join("");
  }

  function addToPool(o, silent) {
    var fp = TP.fingerprint(o);
    var exist = null;
    for (var i = 0; i < pool.length; i++) if (pool[i].id === fp) { exist = pool[i]; break; }
    if (exist) {
      exist.ts = Date.now();
      exist.hits = (exist.hits || 1) + 1;
      // 后来的数据更全就补上
      ["dead", "wait", "toll", "km", "cargo", "goods", "loadTime", "from", "to"].forEach(function (k) {
        if (!exist[k] && o[k]) exist[k] = o[k];
      });
      return { order: exist, dup: true };
    }
    o.id = fp;
    o.ts = Date.now();
    o.hits = 1;
    if (!o.source) {
      // 用"这单自己的行"判断来源，别整段贴文都算（否则连贴多单全被第一单的平台名带走）
      var ownText = (o.rawLines && o.rawLines.length) ? o.rawLines.join("\n") : (o.rawText || "");
      var plat = TP.guessPlatform ? TP.guessPlatform(ownText, o.rawLines)
        : (TP.detectPlatform ? TP.detectPlatform(o.rawLines) : null);
      o.source = plat ? plat.name : "粘贴";
    }
    pool.unshift(o);
    if (pool.length > 300) pool.length = 300;
    return { order: o, dup: false };
  }

  /* =========================================================
     五、粘贴入口：一次可能贴进好几单
     ========================================================= */
  function handlePaste(text) {
    if (!text || !String(text).trim()) { toast("先复制一单再点这里"); return; }
    var list = TP.parseOrders(text);
    if (!list.length) {
      // 兜底：整段当一单
      var one = TP.parseOne(text);
      if (!one) { toast("这段没认出地名和运费，手动填吧"); return; }
      list = [one];
    }
    var added = 0, dups = 0, last = null;
    list.forEach(function (o) {
      if (!o.rawText) o.rawText = text;
      var r = addToPool(o, true);
      if (r.dup) dups++; else added++;
      last = r.order;
    });
    save();
    // 最新的那单放进速算
    setCurrent(last);
    $("pasteSink").value = text;
    $("pasteResult").innerHTML = list.map(function (o, i) {
      return '<div class="pres"><b>' + (i + 1) + "</b> " + esc(o.from || "？") + " → " + esc(o.to || "？") +
        ' <i>' + (o.km ? esc(o.km) + "公里" : "缺公里") + " · ¥" + fmt(o.freight, 0) + "</i></div>";
    }).join("");
    $("pasteResult").hidden = false;
    renderPool();
    toast(added ? "进池 " + added + " 单" + (dups ? "（" + dups + " 单之前贴过）" : "") : "这几单之前都贴过");
  }

  /* =========================================================
     六、账本
     ========================================================= */
  function saveToLedger() {
    var o = fromInputs();
    if (!o.freight) { toast("先填运费"); return; }
    var c = calc(o);
    ledger.push({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      from: o.from, to: o.to, freight: o.freight, km: o.km, dead: o.dead,
      wait: o.wait, toll: o.toll, cargo: o.cargo,
      totalDriven: c.totalDriven, cost: c.cost, net: c.net, hourly: c.hourly,
      perKm: c.perKm, hrs: c.hrs, back: c.back
    });
    save();
    renderLedger();
    toast("记下了：" + (c.net >= 0 ? "净赚 ¥" + fmt(c.net, 0) : "净亏 ¥" + fmt(-c.net, 0)));
  }

  function renderLedger() {
    var t0 = new Date(); t0.setHours(0, 0, 0, 0);
    var td = ledger.filter(function (o) { return o.ts >= t0.getTime(); });
    var m0 = new Date(t0.getFullYear(), t0.getMonth(), 1).getTime();
    var mo = ledger.filter(function (o) { return o.ts >= m0; });
    var week = ledger.filter(function (o) { return o.ts >= Date.now() - 7 * 864e5; });
    var sum = function (a, k) { return a.reduce(function (s, o) { return s + (o[k] || 0); }, 0); };
    var hrs = function (a) { return a.reduce(function (s, o) { return s + (o.hrs || 0); }, 0); };

    $("lToday").textContent = "¥" + fmt(sum(td, "net"), 0);
    $("lTodaySub").textContent = td.length + " 单 · 跑 " + fmt(sum(td, "totalDriven"), 0) + " 公里";
    $("lWeek").textContent = "¥" + fmt(sum(week, "net"), 0);
    $("lWeekSub").textContent = week.length + " 单";
    $("lMonth").textContent = "¥" + fmt(sum(mo, "net"), 0);
    $("lMonthSub").textContent = mo.length + " 单";
    var h = hrs(mo);
    $("lHourly").textContent = h > 0 ? "¥" + fmt(sum(mo, "net") / h, 0) : "—";
    $("lHourlySub").textContent = h > 0 ? "本月 " + fmt(h, 0) + " 小时" : "还没数据";

    var rows = ledger.slice().sort(function (a, b) { return b.ts - a.ts; });
    $("lRows").innerHTML = rows.length ? rows.map(function (o) {
      var d = new Date(o.ts);
      var dd = (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      return '<div class="lrow" data-del="' + esc(o.id) + '">' +
        '<div class="lmain"><div class="lr1">' + esc(o.from || "？") + " → " + esc(o.to || "？") + "</div>" +
        '<div class="lr2">' + dd + " · " + fmt(o.freight, 0) + " 元 · " + fmt(o.totalDriven, 0) + " 公里" +
        (o.hourly != null ? " · 时薪 ¥" + fmt(o.hourly, 0) : "") + "</div></div>" +
        '<div class="lsum"><b class="' + (o.net >= 0 ? "green" : "red") + '">' +
        (o.net >= 0 ? "+" : "") + fmt(o.net, 0) + "</b>" +
        '<button class="linkbtn" data-del="' + esc(o.id) + '">删</button></div>' +
        "</div>";
    }).join("") : '<div class="empty">账本是空的。<br />算完一单点「记下这单」，日子久了就能看出跑哪条线最划算。</div>';
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function exportCsv() {
    if (!ledger.length) { toast("账本还是空的"); return; }
    var head = ["时间", "起点", "终点", "运费", "载货里程", "空驶", "行驶总里程", "装卸小时", "过路费", "成本", "净赚", "每公里", "时薪", "货名"];
    var rows = ledger.slice().sort(function (a, b) { return a.ts - b.ts; }).map(function (o) {
      var d = new Date(o.ts);
      return [d.toLocaleString("zh-CN"), o.from || "", o.to || "", o.freight, o.km, o.dead,
        Math.round(o.totalDriven || 0), o.wait, o.toll, Math.round(o.cost || 0), Math.round(o.net),
        o.perKm == null ? "" : o.perKm.toFixed(2), o.hourly == null ? "" : Math.round(o.hourly), o.cargo || ""];
    });
    var csv = [head].concat(rows).map(function (r) {
      return r.map(function (x) { return '"' + String(x == null ? "" : x).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "货运账本_" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  /* =========================================================
     七、复制话术
     ========================================================= */
  function bidText() {
    var o = fromInputs();
    var c = calc(o);
    return "这趟 " + (o.from || "") + "→" + (o.to || "") + " " + (o.km || "") + "公里，我这边净到手要 " +
      c.bid + " 才能跑（油钱过路装卸全算上）。" + c.bid + " 能接我马上到。";
  }

  function orderText() {
    var o = fromInputs();
    var c = calc(o);
    var L = [];
    L.push((o.from || "？") + " → " + (o.to || "？"));
    if (o.km) L.push("载货 " + o.km + " 公里" + (o.dead ? "，空驶 " + o.dead + " 公里" : ""));
    L.push("运费 ¥" + fmt(o.freight, 0));
    if (o.wait) L.push("装卸约 " + o.wait + " 小时");
    if (o.toll) L.push("过路费 ¥" + fmt(o.toll, 0));
    L.push("油钱 ¥" + fmt(c.fuel, 0) + (c.back ? "（含返程）" : ""));
    L.push("净赚 ¥" + fmt(c.net, 0) + (c.hourly != null ? "，时薪 ¥" + fmt(c.hourly, 0) : ""));
    return L.join("，");
  }

  /* =========================================================
     八、设置
     ========================================================= */
  function fillSettings() {
    $("setFuel").value = S.fuel;
    $("setPrice").value = S.price;
    $("setSpeed").value = S.speed;
    $("setTarget").value = S.target;
    $("setFixed").value = S.fixed;
    // v7：以前版本把「杭州」硬塞进来，那个值不是定位来的，清掉让用户自己定位
    if (S.home === "杭州" && !S.homeSet) S.home = "";
    $("setHome").value = S.home || "";
    $("setComeBack").checked = !!S.comeBack;
    $("setStale").value = S.staleMin;
    $("amapKey").value = S.amapKey || "";
    $("amapSec").value = S.amapSec || "";
  }

  /* v7：地图算出来的数字填回速算表；用户已经填了更大的值就不往下改 */
  function fillRoute(r) {
    var changed = false;
    var apply = function (id, v, isText) {
      var el = $(id);
      if (!el) return;
      if (isText) {
        if (v && !el.value.trim()) { el.value = v; changed = true; }
        return;
      }
      if (v == null) return;
      var old = parseFloat(el.value);
      // 空着，或者用户填的比地图给的还小（大概是没量准），才覆盖
      if (!isFinite(old) || old <= 0 || old < v) { el.value = v; changed = true; }
    };
    apply("qpDead", r.dead);
    apply("qpKm", r.km);
    apply("qpToll", r.toll);
    var lp = $("locPick"), ld = $("locDest");
    if (lp) apply("qpFrom", (lp.value || "").trim(), true);
    if (ld) apply("qpTo", (ld.value || "").trim(), true);
    if (changed) renderQuick();
    return changed;
  }

  /* v7.1：地图结果单独算、单独显示——只用地图给的 dead/km/toll + 上面表单里的运费，
     不影响、也不读取「粘贴算账」那套的起终点和里程。两个功能互不覆盖。 */
  function showMapResult(r) {
    mapLast = {
      dead: r.dead || 0, km: r.km || 0, toll: r.toll || 0,
      from: ($("locPick").value || "").trim(),
      to: ($("locDest").value || "").trim()
    };
    var box = $("mapResult");
    if (box) box.hidden = false;   // 先显示出来，renderMapResult 里才不会被 hidden 挡住
    renderMapResult();
    if (box) { try { box.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) {} }
  }

  function renderMapResult() {
    var box = $("mapResult");
    if (!box || !mapLast) return;
    // 运费沿用「粘贴算账」表单里的运费（地图本身不产运费）；其余用地图量出来的
    var o = {
      from: mapLast.from, to: mapLast.to,
      freight: num($("qpFreight").value),
      km: mapLast.km, dead: mapLast.dead, toll: mapLast.toll,
      wait: num($("qpWait").value), cargo: "", rawLines: []
    };
    var c = calc(o);
    var v = verdictOf(c);
    var vd = $("qmVerdict");
    if (vd) { vd.className = "verdict" + (v.cls ? " " + v.cls : ""); vd.textContent = v.text; }
    if ($("qmNet")) $("qmNet").textContent = c.freight ? fmt(c.net, 0) : "0";
    if ($("qmBigRow")) $("qmBigRow").className = "big" + (c.net < 0 ? " neg" : "");
    if ($("qmHourly")) $("qmHourly").textContent = c.hourly == null ? "—" : "¥" + fmt(c.hourly, 0);
    if ($("qmPerKm")) $("qmPerKm").textContent = c.perKm == null ? "—" : "¥" + fmt(c.perKm, 2);
    if ($("qmHours")) $("qmHours").textContent = c.hrs > 0 ? fmt(c.hrs, 1) + "h" : "—";
    var bits = [];
    if (c.totalDriven > 0) bits.push("跑 " + fmt(c.totalDriven, 0) + " 公里" + (c.back ? "（含返程）" : ""));
    if (c.fuel > 0) bits.push("油钱 ¥" + fmt(c.fuel, 0));
    if (c.toll > 0) bits.push("过路 ¥" + fmt(c.toll, 0));
    if (c.wait > 0) bits.push("等 " + fmt(c.wait, 1) + " 小时");
    if ($("qmBreak")) $("qmBreak").textContent = bits.join("　·　") || "——";
  }

  /* =========================================================
     九、路由 / 事件
     ========================================================= */
  function go(page) {
    document.querySelectorAll(".page").forEach(function (p) {
      var on = p.dataset.page === page;
      p.hidden = !on;
      p.style.display = on ? "" : "none";
    });
    document.querySelectorAll(".navb button").forEach(function (b) { b.classList.toggle("on", b.dataset.go === page); });
    if (page === "pool") renderPool();
    if (page === "ledger") renderLedger();
    if (page === "settings") fillSettings();
    if (page === "calc") setTimeout(maybeLoadMap, 120);
    window.scrollTo(0, 0);
  }

  /* 定位拿到的地名存下来（点了「用当前位置」才算数，绝不自己填） */
  function commitHome(v) {
    S.home = v; S.homeSet = true; save();
    var h = $("setHome");
    if (h) h.value = v;
    toast("已填上：" + v);
  }

  /* v7：地图按需加载，第一次进算账页才去要脚本，省移动流量 */
  function maybeLoadMap() {
    if (!S.mapOn) return;
    var box = $("mapBox");
    if (box) box.classList.add("on");
    if (window.TruckMap) window.TruckMap.load();
  }

  /* 打开地图卡时把起点终点带过去，省得再打一遍 */
  function syncMapInputs() {
    var o = fromInputs();
    var pick = $("locPick"), dest = $("locDest"), now = $("locNow");
    if (o.from && pick && !pick.value.trim()) pick.value = o.from;
    if (o.to && dest && !dest.value.trim()) dest.value = o.to;
    if (now && !now.value.trim() && S.home) now.value = S.home;
  }

  function bind() {
    // —— 粘贴入口
    var sink = $("pasteSink");
    sink.addEventListener("input", function () {
      if (sink.value.trim().length > 6) handlePaste(sink.value);
    });
    $("pasteBtn").onclick = function () { pasteFromClipboard(); };
    // 点「粘贴一单」：先尽量直接读剪贴板；读不到就把框备好让你长按粘贴，绝不用你自己打字
    function pasteFromClipboard() {
      try { if (window.focus) window.focus(); } catch (e) {}
      var askPerm = (navigator.permissions && navigator.permissions.query)
        ? navigator.permissions.query({ name: "clipboard-read" }).catch(function () { return null; })
        : Promise.resolve(null);
      askPerm.then(function () {
        if (!(navigator.clipboard && navigator.clipboard.readText)) throw new Error("no-api");
        return navigator.clipboard.readText();
      }).then(function (t) {
        if (t && String(t).trim()) { sink.value = t; handlePaste(t); }
        else { manualPaste("剪贴板是空的——先去那单上长按「复制」，再回来点这里"); }
      }).catch(function () {
        manualPaste("这个浏览器不让直接读剪贴板（微信/QQ 里打开常见），框已经选好了：长按框 →「粘贴」就行");
      });
    }
    // 读不到时：把框显示出来、聚焦、选中；能长按粘贴的 WebView 再兜底试一下 execCommand
    function manualPaste(msg) {
      var box = sink.closest(".pastebox"); if (box) box.hidden = false;
      sink.hidden = false;
      try { sink.focus(); } catch (e) {}
      try { sink.setSelectionRange(0, 0); } catch (e) {}
      try { document.execCommand("paste"); } catch (e) {}
      toast(msg || "框已经选好了：长按框 →「粘贴」");
    }
    $("pasteClear").onclick = function () {
      sink.value = ""; $("pasteResult").hidden = true; $("pasteResult").innerHTML = "";
    };

    // —— 速算输入
    ["qpFreight", "qpKm", "qpDead", "qpWait", "qpToll", "qpFrom", "qpTo", "qpCargo"].forEach(function (id) {
      $(id).addEventListener("input", function () { renderQuick(); renderMapResult(); });
    });
    $("qComeBack").checked = !!S.comeBack;
    $("qComeBack").onchange = function () {
      S.comeBack = $("qComeBack").checked; save(); renderQuick(); renderPool();
    };

    $("qCopyBid").onclick = function () {
      copy(bidText()).then(function (ok) { toast(ok ? "报价话术已复制" : "复制失败，长按框手选"); });
    };
    $("qCopyOrder").onclick = function () {
      copy(orderText()).then(function (ok) { toast(ok ? "这单信息已复制" : "复制失败，长按框手选"); });
    };
    $("qSave").onclick = saveToLedger;
    $("qSavePool").onclick = function () {
      var o = fromInputs();
      if (!o.freight && !o.km && !o.from) { toast("先贴单或填数"); return; }
      var r = addToPool(o);
      save(); renderPool();
      toast(r.dup ? "这单池子里已经有了" : "已加进单池");
    };

    // —— 单池
    $("poolList").onclick = function (e) {
      var card = e.target.closest(".ord");
      if (!card) return;
      var id = card.dataset.id;
      var o = null;
      for (var i = 0; i < pool.length; i++) if (pool[i].id === id) { o = pool[i]; break; }
      if (!o) return;
      var act = (e.target.closest("button[data-act]") || {}).dataset;
      if (act && act.act === "del") {
        pool = pool.filter(function (x) { return x.id !== id; });
        save(); renderPool(); toast("删了");
        return;
      }
      if (act && act.act === "copy") {
        var c = calc(o);
        copy("这趟 " + (o.from || "") + "→" + (o.to || "") + " " + (o.km || "") + "公里，我这边净到手要 " +
          c.bid + " 才能跑（油钱过路装卸全算上）。" + c.bid + " 能接我马上到。")
          .then(function (ok) { toast(ok ? "报价话术已复制" : "复制失败"); });
        return;
      }
      // 其余：算这单
      setCurrent(o);
      go("calc");
    };

    $("poolSort").onchange = renderPool;
    $("poolKeyword").addEventListener("input", renderPool);
    $("poolHideBad").onchange = renderPool;
    $("poolClear").onclick = function () {
      if (!pool.length) return;
      if (confirm("清空单池里的 " + pool.length + " 单？（账本不动）")) {
        pool = []; save(); renderPool(); toast("单池已清空");
      }
    };

    // 单池提示只弹一次（这次打开页面内）



    // —— 账本
    $("lExport").onclick = exportCsv;
    $("lRows").onclick = function (e) {
      var b = e.target.closest("[data-del]");
      if (!b) return;
      var id = b.dataset.del;
      if (!confirm("删掉这条记账？")) return;
      ledger = ledger.filter(function (o) { return o.id !== id; });
      save(); renderLedger();
    };
    $("lClear").onclick = function () {
      if (!ledger.length) return;
      if (confirm("清空所有记账？导出的 CSV 不受影响。")) { ledger = []; save(); renderLedger(); }
    };

    // —— 设置
    $("saveSettings").onclick = function () {
      S.fuel = num($("setFuel").value) || DEFAULTS.fuel;
      S.price = num($("setPrice").value) || DEFAULTS.price;
      S.speed = num($("setSpeed").value) || DEFAULTS.speed;
      S.target = num($("setTarget").value) || DEFAULTS.target;
      S.fixed = num($("setFixed").value);
      S.home = $("setHome").value.trim();
      S.comeBack = $("setComeBack").checked;
      S.staleMin = num($("setStale").value) || 8;
      S.amapKey = $("amapKey").value.trim();
      S.amapSec = $("amapSec").value.trim();
      save(); renderQuick(); renderPool(); renderLedger();
      toast("设置已保存");
    };

    // —— v7：定位 / 地图
    if ($("setHomeBtn")) {
      $("setHomeBtn").onclick = function () {
        if (window.TruckMap) window.TruckMap.useHere(commitHome);
        else toast("地图脚本没加载出来，刷新一下");
      };
    }
    if ($("btnGeo")) {
      $("btnGeo").onclick = function () {
        if (window.TruckMap) window.TruckMap.locate(false);
        else toast("地图脚本没加载出来，刷新一下");
      };
    }
    if ($("btnRoute")) {
      $("btnRoute").onclick = function () {
        if (window.TruckMap) window.TruckMap.runRoute();
        else toast("地图脚本没加载出来，刷新一下");
      };
    }
    if ($("btnUseNow")) {
      // 把地图里定位到的位置，存成「我现在在哪」
      $("btnUseNow").onclick = function () {
        var v = ($("locNow").value || "").trim();
        if (!v) { toast("先点「定位」或填个地名"); return; }
        S.home = v; S.homeSet = true; save();
        $("setHome").value = v;
        toast("已记为我的位置：" + v);
      };
    }
    if ($("btnMapReload")) {
      $("btnMapReload").onclick = function () {
        if (window.TruckMap) window.TruckMap.setKeys();
      };
    }
    if ($("saveAmap")) {
      $("saveAmap").onclick = function () {
        S.amapKey = $("amapKey").value.trim();
        S.amapSec = $("amapSec").value.trim();
        save();
        if (!S.amapKey) { toast("Key 是空的，地图加载不了"); return; }
        toast("已保存，正在重新加载地图");
        if (window.TruckMap) window.TruckMap.setKeys();
      };
    }
    if ($("qMapBtn")) {
      $("qMapBtn").onclick = function () {
        syncMapInputs();
        var card = $("locPick").closest(".card");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
        if (window.TruckMap) window.TruckMap.load();
        setTimeout(function () {
          var el = $("locPick");
          if (el && !el.value.trim()) el.focus();
        }, 420);
      };
    }
    ["locNow", "locPick", "locDest"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("change", function () {
        try { localStorage.setItem("truckv7.loc." + id, el.value); } catch (e) {}
      });
      try {
        var v = localStorage.getItem("truckv7.loc." + id);
        if (v && el && !el.value) el.value = v;
      } catch (e) {}
    });

    document.querySelectorAll("[data-go]").forEach(function (b) {
      b.onclick = function () { go(b.dataset.go); };
    });

    // 全局：在速算页直接 Ctrl+V / 长按粘贴也能接住
    document.addEventListener("paste", function (e) {
      var t = (e.clipboardData || window.clipboardData);
      if (!t) return;
      var txt = t.getData("text");
      if (!txt || !txt.trim()) return;
      // 输入框里的粘贴不拦
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.id !== "pasteSink") return;
      e.preventDefault();
      $("pasteSink").value = txt;
      handlePaste(txt);
    });

    // 页面切换刷新"多久前"
    setInterval(function () {
      if (!$(".page[data-page='pool']").hidden) renderPool();
    }, 30000);
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    load();
    bind();
    fillSettings();
    renderQuick();
    renderPool();
    renderLedger();
    go("calc");
    // v7：地图第一次要用了才加载（等页面空下来，别抢首页的渲染）
    setTimeout(maybeLoadMap, 1400);
    // 第一次用给个提示
    if (!pool.length && !ledger.length) {
      setTimeout(function () { toast("在 App 里长按单子的文字→复制，回来点「粘贴」"); }, 900);
    }
  }

  // 给 map.js 用的钩子（v7）
  window.TruckApp = {
    settings: function () { return S; },
    toast: toast,
    fillRoute: fillRoute,
    showMapResult: showMapResult,
    go: go,
    num: num
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
