/* ================= 单子文本解析器 parse.js =================
   目标：爸爸在货拉拉/运满满/满帮/快狗/省省回头车等 App 里长按复制出来的那段文字，
   不管排版多乱，都能认出：起点、终点、运费、公里数、装货时间、车型、货名、空驶。
   设计原则：
   1) 先按行切，再按行打标签，但"用掉的字符要挖掉"，避免互相抢词
      （否则 里程里的数字会被当成运费、"装货时间"会被当成地名）。
   2) 一段文本可能含多单：按「运费行」切分；没有运费的段落归到当前单当补充。
   3) 起点/终点先认「装货地：X 卸货地：Y」这种带标签的，
      再认「A → B」这种箭头连接的，最后才去整行里抓地名。
   ============================================================ */
(function (global) {
  "use strict";

  var FROM_LABEL_RE = /(?:装货地(?:址|点)?|装货点|起点|出发地|发货地|提货地|起运地|装货|发货|始发地)\s*[：:]?\s*/;
  var TO_LABEL_RE = /(?:卸货地(?:址|点)?|卸货点|终点|目的地|收货地|送货地|到达地|卸货|送货|目的地)\s*[：:]?\s*/;

  // 地名尾巴
  var PLACE_TAIL = "市辖区|市|县|区|镇|乡|村|街道|路|街|大道|市场|工业园|工业区|物流园|开发区|园区|港口|港|码头|仓库|库|车站|站|机场|小区|大厦|广场|中心|服务区|保税区";
  var PLACE_RE = new RegExp("([\\u4e00-\\u9fa5]{2,6}?(?:" + PLACE_TAIL + "))", "g");
  var PLACE_HINT = /[市州县区镇乡村街道路港站场园库厦苑广场]|机场|物流|工业|开发|保税|大道/;

  var CARGO_RE = /((?:\d+(?:\.\d+)?)\s*米[^，,。；;\s]{0,10}|依维柯|面包车|金杯|小货车|小面|中面|平板车|高栏车|厢式车|厢货|冷藏车|保温车|半挂|挂车|前四后八|危险品车|微卡|双排|翻斗|自卸)/;
  var GOODS_LABEL_RE = /(?:货物名称|货品名称|货物|货品|货名|品类|品名|名称)\s*[：:]\s*([^\s，,。；;]{1,16})/;
  var CARGO_LABEL_RE = /(?:车型|车辆类型|车辆|车长|需求车型|用车类型|车箱)\s*[：:]\s*([^\s，,。；;]{1,18})/;

  var CN_NUM = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

  var PLAT_NAME_RE = /滴滴货运|滴滴出行|货拉拉|运满满|货车帮|满帮|快狗打车|快狗|58速运|省省回头车|省省|货源宝|货运宝|运车管家|铁牛|运力帮/g;

  function clean(s) {
    return String(s == null ? "" : s)
      .replace(/\u00a0|\u3000/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/【[^】]{0,12}】/g, " ")
      .replace(PLAT_NAME_RE, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/^[\s·•\-—–~、,，。;；:：]+|[\s·•\-—–~、,，。;；:：]+$/g, "")
      .trim();
  }
  function money(s) { return parseFloat(String(s).replace(/,/g, "")) || 0; }

  /** 从一段文字里抠最像地名的一串 */
  function pickPlace(str) {
    if (!str) return "";
    // 先看有没有"……到/至/往……"这种中文连接，有就只取左边那一半
    var s = String(str);
    var conn = s.match(/^([^\s]{2,12}?)\s*(?:到|至|往|去)\s*[\u4e00-\u9fa5]{2,}/);
    if (conn) {
      var left = conn[1];
      var lh = pickOne(left);
      if (lh && !isLabel(lh)) return lh;
    }
    return pickOne(s);
  }

  function pickOne(str) {
    if (!str) return "";
    var s = String(str);
    var best = "", bestLen = 0, m;
    PLACE_RE.lastIndex = 0;
    while ((m = PLACE_RE.exec(s))) {
      var g = m[1];
      // 去掉前面的动词/介词
      g = g.replace(/^(?:从|在|由|到|往|至|去|是|为|约)+/, "");
      if (g.length > bestLen && !/^(?:公里|千米|公里数|小时|运费|里程|全程|距离|时间)$/.test(g)) {
        best = g; bestLen = g.length;
      }
    }
    if (best) return best;
    // 没有明显后缀：把标签词/招呼语去掉，取第一段 2~12 个汉字
    var bare = s.replace(FROM_LABEL_RE, "").replace(TO_LABEL_RE, "")
      .replace(/[，,。；;:：]/g, " ").trim();
    var cands = bare.match(/[\u4e00-\u9fa5]{2,12}/g) || [];
    for (var i = 0; i < cands.length; i++) {
      if (!isLabel(cands[i])) return cands[i];
    }
    return "";
  }

  var ARROW_SPLIT = /\s*(?:→|➡|⇒|⟶|-->|-{1,2}>|—>|＞|>|至|到|~|～|\||—|–|-|\/|—|～)\s*/;

  // 这些词说明"左边这串不是地名，是个标签"
  var LABEL_WORDS = /^(?:线路|路线|行程|货源|订单|单号|编号|装货地|卸货地|起点|终点|出发地|目的地|发货地|收货地|提货地|送货地|地址|货物|货名|货品|品类|车型|车辆|车长|运费|报价|价格|里程|距离|全程|总里程|空驶|等待|装卸|时间|装货时间|联系电话|电话|重量|备注|要求|编号)\s*$/;

  // 明显不是地名的词（口头语、招呼、联系方式提示等）
  var NOT_PLACE_WORDS = /^(?:有车吗|有车没|有车|求车|找车|车主|货主|老板|师傅|你好|在吗|急|急找|急求|有意|联系|私聊|电话|微信|转发|群|招聘|招工)/;

  function isLabel(s) {
    return !s || LABEL_WORDS.test(s) || NOT_PLACE_WORDS.test(s) || /^【/.test(s);
  }

  function splitRoute(line) {
    if (!line) return null;
    var fi = line.search(FROM_LABEL_RE);
    var ti = line.search(TO_LABEL_RE);
    if (fi >= 0 && ti > fi) {
      var f = pickPlace(line.slice(fi, ti));
      var t = pickPlace(line.slice(ti));
      if (f || t) return { from: f, to: t };
    }
    if (ti >= 0 && fi < 0) return { from: "", to: pickPlace(line.slice(ti)) };
    if (fi >= 0 && ti < 0) return { from: pickPlace(line.slice(fi)), to: "" };

    var parts = line.split(ARROW_SPLIT).map(clean).filter(function (x) { return x && !/^[\d.\s]+$/.test(x); });
    if (parts.length >= 2) {
      // 先把"线路：""起点："这类标签从每一段头上剥掉
      var segs = parts.map(function (x) {
        var y = clean(String(x).replace(/^[^：:]{1,6}[：:]\s*/, ""));
        return y || x;
      });
      var first = segs[0], last = segs[segs.length - 1];
      var a = pickPlace(first), b = pickPlace(last);
      if (isLabel(a)) a = "";
      if (isLabel(b)) b = "";
      // 左边是招呼语时，从左往右找第一个真地名
      if (!a) {
        for (var i = 0; i < segs.length - 1 && !a; i++) {
          var cand = pickPlace(segs[i]);
          if (cand && !isLabel(cand)) a = cand;
        }
      }
      // 右边是标签/招呼语时，从右往左找第一个真地名
      if (!b) {
        for (var j = segs.length - 1; j > 0 && !b; j--) {
          var cb = pickPlace(segs[j]);
          if (cb && !isLabel(cb)) b = cb;
        }
      }
      if (a && b && a !== b) return { from: a, to: b };
      var pa = first, pb = last;
      if (pa && pb && pa !== pb && PLACE_HINT.test(pa + pb) && !isLabel(pa) && !isLabel(pb)) {
        return { from: pa.slice(0, 14), to: pb.slice(0, 14) };
      }
    }
    return null;
  }

  /* -------- 单行打标签：返回 {fields, restLine} -------- */
  var P = {
    toll: /(?:过路费|高速费|路桥费|过桥费|过路)\s*[：:]?\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/,
    dead: /(?:空驶|空跑|放空|回程空驶|空车)\s*[：:约]*\s*([\d.]+)\s*(?:公里|千米|km|KM)?/,
    dead2: /(?:距离你|距你|距离我|离你|距离约)\s*[：:约]*\s*([\d.]+)\s*(?:公里|千米|km|KM)/,
    wait: /(?:等(?:待|候)?|排队|压车)\s*[：:约]*\s*([\d.]+)\s*(?:个)?\s*(?:小时|钟头|h|H)/,
    wait2: /(?:装卸|装货等待|装卸时间|装卸时长)\s*[：:约]*\s*([\d.]+)\s*(?:个)?\s*(?:小时|钟头|h|H)/,
    price: /(?:运费|报价|价格|总额|总价|运费总额|费用|到手价|司机所得)\s*[：:约]?\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)\s*(?:元|块)?/,
    price2: /[¥￥]\s*([\d,]+(?:\.\d+)?)/,
    price3: /([\d,]{2,}(?:\.\d+)?)\s*(?:元|块钱)/,
    km: /(?:全程|总里程|里程|距离|公里数|路程|行驶)\s*[：:约]?\s*(?:约|大约|大概)?\s*([\d.]+)\s*(?:公里|千米|km|KM|Km)?/,
    km2: /([\d.]+)\s*(?:公里|千米|km|KM|Km)(?!\s*\/(?:小时|h))/,
    weight: /([\d.]+)\s*(吨|t|T|方|立方|m³|m3)/,
    phone: /(1[3-9]\d{9})/,
    time: /(?:装货时间|装车时间|用车时间|发车时间|发货时间|装货日期)\s*[：:]?\s*([^\s，,。；;]{2,26})/,
    time2: /(?:(\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)\s*(?:[上下]午)?\s*(\d{1,2}\s*[:：]\s*\d{2})?)/,
    time3: /((?:今天|明天|后天|今早|明早|今晚|马上|随时|现在|今天下午|明天上午)(?:\s*[上下]午)?(?:\s*\d{1,2}\s*[:：]\s*\d{2})?)/
  };

  function tagLine(line) {
    var t = " " + line + " ";
    var f = {};
    var m;
    function take(re, key, transform) {
      var mm = t.match(re);
      if (!mm) return false;
      f[key] = transform ? transform(mm) : mm[1];
      t = t.replace(mm[0], " ");
      return true;
    }
    take(P.toll, "toll", function (m) { return money(m[1]); });
    take(P.dead, "dead", function (m) { return parseFloat(m[1]); }) || take(P.dead2, "dead", function (m) { return parseFloat(m[1]); });
    take(P.price, "freight", function (m) { return money(m[1]); }) ||
      take(P.price2, "freight", function (m) { return money(m[1]); }) ||
      take(P.price3, "freight", function (m) { return money(m[1]); });
    take(P.wait, "wait", function (m) { return parseFloat(m[1]); }) || take(P.wait2, "wait", function (m) { return parseFloat(m[1]); });
    take(P.km, "km", function (m) { return parseFloat(m[1]); }) || take(P.km2, "km", function (m) { return parseFloat(m[1]); });
    take(GOODS_LABEL_RE, "goods", function (m) { return clean(m[1]); });
    take(CARGO_LABEL_RE, "cargo", function (m) { return clean(m[1]); });
    if (!f.cargo) take(CARGO_RE, "cargo", function (m) { return clean(m[1]); });
    take(P.weight, "weight", function (m) { return clean(m[1] + m[2]); });
    take(P.phone, "phone", function (m) { return m[1]; });
    if (!take(P.time, "loadTime", function (m) { return clean(m[1]); })) {
      take(P.time2, "loadTime", function (m) { return clean(m[1] + (m[2] ? " " + m[2] : "")); }) ||
        take(P.time3, "loadTime", function (m) { return clean(m[1]); });
    }
    // 去掉残留的裸数字和单位，剩下的才是"可能含地名"的文本
    var rest = t.replace(/[¥￥]/g, " ").replace(/\b\d+(?:\.\d+)?\b/g, " ")
      .replace(/[·•]/g, " ").replace(/\s{2,}/g, " ").trim();
    return { f: f, rest: rest, full: line };
  }

  /* ---------------- 主解析 ---------------- */
  function parseOrders(text) {
    var raw = String(text || "");
    if (!raw.trim()) return [];
    raw = raw.replace(/\r/g, "\n");
    var lines = raw.split(/\n+/).map(clean).filter(Boolean);

    var out = [];
    var cur = null;

    function newOrder() {
      return {
        from: "", to: "", freight: 0, km: 0, dead: 0, wait: 0, toll: 0,
        cargo: "", goods: "", weight: "", loadTime: "", phone: "", rawLines: []
      };
    }
    function push() { if (cur && (cur.freight > 0 || (cur.from && cur.to))) out.push(cur); cur = null; }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // 噪音行
      if (/^(?:—+|--+|\*+|·{2,}|\d+\/\d+|展开|收起|查看详情|立即联系|电话联系|抢单|已实名|保证金|货拉拉|运满满|满帮|货车帮|快狗打车|省省回头车|滴滴货运|货运)[:：]?$/.test(line)) continue;
      if (/^(?:识别到|这是|以下是|为您找到|附近|推荐)/.test(line)) continue;

      var tag = tagLine(line);

      // 遇到"有新运费"且当前单已有运费 → 切单
      if (tag.f.freight > 0 && cur && cur.freight > 0) push();
      if (!cur) cur = newOrder();

      // 数字类：本行有就以本行为准（"等待2小时 · 过路费580" 两个都要拿到）
      // 文本类：已填过且不是本行认出的，就别覆盖
      var TEXT_KEYS = { cargo: 1, goods: 1, weight: 1, loadTime: 1, phone: 1 };
      Object.keys(tag.f).forEach(function (k) {
        var v = tag.f[k];
        if (v === "" || v == null) return;
        if (TEXT_KEYS[k]) {
          if (!cur[k]) cur[k] = v;
        } else {
          var nv = typeof v === "number" ? v : parseFloat(v);
          if (isFinite(nv) && nv > 0) cur[k] = nv;
          else if (!cur[k]) cur[k] = v;
        }
      });
      cur.rawLines.push(line);

      // 线路：优先用本行剩下的文本，认不出再用整行
      var r = splitRoute(tag.rest) || splitRoute(line);
      if (r) {
        if (r.from && !cur.from) cur.from = r.from;
        if (r.to && !cur.to && r.to !== r.from) cur.to = r.to;
      }

      // 注意：这里【不能】一凑齐就收单。
      // 平台卡片是"线路一行、价格一行、等待/过路一行、距离你一行"，
      // 一收单后面的等待/过路/空驶就全丢了。切单只靠上面"遇到新运费行"。
    }
    push();

    // 收尾清理
    return out.map(function (o) {
      if (o.from && o.to && o.from === o.to) o.to = "";
      if (!o.from && o.to) { o.from = o.to; o.to = ""; }
      return o;
    }).filter(function (o) { return o.freight > 0 || (o.from && o.to); });
  }

  /* ---------------- 一行式兜底 ---------------- */
  function parseOne(text) {
    var list = parseOrders(text);
    if (list.length) {
      // 一行里有多单时取运费最高的那单
      return list.slice().sort(function (a, b) { return (b.freight || 0) - (a.freight || 0); })[0];
    }
    var t = clean(text);
    if (!t) return null;
    var tag = tagLine(t);
    var r = splitRoute(tag.rest) || splitRoute(t);
    var o = {
      from: r && r.from || "", to: r && r.to || "",
      freight: tag.f.freight || 0, km: tag.f.km || 0, dead: tag.f.dead || 0,
      wait: tag.f.wait || 0, toll: tag.f.toll || 0, cargo: tag.f.cargo || "",
      goods: tag.f.goods || "", weight: tag.f.weight || "", loadTime: tag.f.loadTime || "",
      phone: tag.f.phone || "", rawLines: [t]
    };
    if (!o.freight && !o.km && !o.from) return null;
    return o;
  }

  /* ---------------- 指纹：去掉重复贴的同一单 ---------------- */
  function fingerprint(o) {
    var key = [o.from, o.to].join("|") + "#" + Math.round(o.freight || 0) + "#" + Math.round(o.km || 0);
    var h = 5381;
    for (var i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) & 0x7fffffff;
    return "p" + h.toString(36);
  }

  /* ---------------- 平台识别（只是给单子打个来源标签，跟能不能解析无关） ---------------- */
  var PLATFORMS = [
    { id: "huolala", name: "货拉拉", re: /货拉拉|huolala|啦啦/i },
    { id: "yunmanman", name: "运满满", re: /运满满|ymm56|ymm\b/i },
    { id: "manbang", name: "满帮", re: /满帮|货车帮|manbang|hb56/i },
    { id: "didihuoyun", name: "滴滴货运", re: /滴滴货运|滴滴|didihuoyun/i },
    { id: "kuaigou", name: "快狗打车", re: /快狗|kuaigou|58速运/i },
    { id: "shengsheng", name: "省省回头车", re: /省省|回头车|shengsheng/i },
    { id: "huoyuanbang", name: "货源宝/其他", re: /货源宝|货运宝|运车管家|铁牛|运力帮/i }
  ];

  function detectPlatform(lines) {
    var s = (lines || []).join(" ");
    for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i].re.test(s)) return PLATFORMS[i];
    return null;
  }

  /* 平台名常被 clean() 当噪词删掉，所以要在原文里认；
     另加"看排版猜平台"：运满满/满帮是"装货地：xx 卸货地：yy"那种标签行，
     快狗/滴滴是卡片式带车型和"距你x公里"。 */
  var LAYOUT_HINTS = [
    { id: "kuaigou", name: "快狗打车", re: /装货地址[：:]|卸货地址[：:]|距你\s*[\d.]+\s*公里/ },
    { id: "shengsheng", name: "省省回头车", re: /线路[：:][^\n]*[→\-—>]/ },
    { id: "didihuoyun", name: "滴滴货运", re: /一键叫车|立即叫车|附近车源/ },
    { id: "huolala", name: "货拉拉", re: /马上抢|抢单|立即下单|货到付款/ },
    { id: "yunmanman", name: "运满满", re: /装货地[：:][^\n]*卸货地[：:]/ },
    { id: "manbang", name: "满帮", re: /车牌号|实名认证|保证金/ }
  ];

  function guessPlatform(rawText, lines) {
    var hit = detectPlatform([rawText]);
    if (hit) return hit;
    var s = (lines || []).join("\n") || String(rawText || "");
    for (var i = 0; i < LAYOUT_HINTS.length; i++) {
      if (LAYOUT_HINTS[i].re.test(s)) {
        for (var j = 0; j < PLATFORMS.length; j++) {
          if (PLATFORMS[j].id === LAYOUT_HINTS[i].id) return PLATFORMS[j];
        }
      }
    }
    return null;
  }

  global.TruckParse = {
    parseOrders: parseOrders,
    parseOne: parseOne,
    fingerprint: fingerprint,
    splitRoute: splitRoute,
    pickPlace: pickPlace,
    clean: clean,
    tagLine: tagLine,
    detectPlatform: detectPlatform,
    guessPlatform: guessPlatform,
    PLATFORMS: PLATFORMS
  };
})(typeof window !== "undefined" ? window : this);
