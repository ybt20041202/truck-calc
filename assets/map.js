/* ================= 三地点定位算里程（map.js）=================
   现在的位置 → 取货地 → 目的地，用高德算两段路线：
   第一段距离 = 空驶，第二段距离 = 载货里程，过路费两段相加。
   算完自动填回「算账」页，不覆盖已经填好的更大数值。
   老站（truck-calc-orig.html）那套逻辑原样搬过来，改成走 v6 的字段。
   -------------------------------------------------------------
   依赖：window.TruckApp（app.js 暴露的钩子）
   导出：window.TruckMap = { load, locate, useHere, runRoute, setKeys, isReady }
   ============================================================ */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var MAP = {
    map: null, geo: null, driving: null, drivingBroken: false,
    ac: [], pts: {}, txt: {}, loaded: false, loading: false
  };

  function S() { return window.TruckApp && window.TruckApp.settings ? window.TruckApp.settings() : {}; }
  function toast(m) { window.TruckApp && window.TruckApp.toast && window.TruckApp.toast(m); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) {
    var x = parseFloat(String(v == null ? "" : v).replace(/,/g, "."));
    return isFinite(x) ? x : null;
  }
  function info(html) { var el = $("mapInfo"); if (el) el.innerHTML = html; }

  /* 把各种来源的坐标统一成 [经度, 纬度] */
  function ptArr(p) {
    if (!p) return null;
    var lng = num(p.lng !== undefined ? p.lng : (typeof p.getLng === "function" ? p.getLng() : NaN));
    var lat = num(p.lat !== undefined ? p.lat : (typeof p.getLat === "function" ? p.getLat() : NaN));
    if (lng === null || lat === null) return null;
    if (lng < 70 || lng > 140 || lat < 3 || lat > 55) return null;
    return [lng, lat];
  }

  function dur(sec) {
    var m = Math.round((sec || 0) / 60);
    if (m < 60) return m + " 分钟";
    return Math.floor(m / 60) + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : "");
  }

  /* ---------------- 加载高德 ---------------- */
  function load(force) {
    var s = S();
    if (!s.amapKey && !force) { info("没填高德 Key，地图用不了。设置页填一个就行（老站那个 Key 已经带过来了）。"); return; }
    if (window.AMap) { initMap(); return; }
    if (MAP.loading) return;
    MAP.loading = true;
    info("正在加载地图…");
    window._AMapSecurityConfig = { securityJsCode: s.amapSec || "" };
    var sc = document.createElement("script");
    sc.src = "https://webapi.amap.com/maps?v=2.0&key=" + encodeURIComponent(s.amapKey) +
      "&plugin=AMap.Driving,AMap.Geolocation,AMap.AutoComplete,AMap.Geocoder";
    sc.onload = function () { MAP.loading = false; MAP.loaded = true; initMap(); };
    sc.onerror = function () {
      MAP.loading = false;
      info("地图没加载出来：检查网络，或者 Key 是不是填错了。<br />改完 Key 点下面的「重新加载地图」。");
      var b = $("btnMapReload"); if (b) b.hidden = false;
    };
    document.head.appendChild(sc);
  }

  function initMap() {
    if (MAP.map || !window.AMap) return;
    try {
      MAP.map = new window.AMap.Map("mapBox", { zoom: 10, viewMode: "2D" });
      MAP.geo = new window.AMap.Geolocation({ enableHighAccuracy: true, timeout: 9000 });
      MAP.map.addControl(MAP.geo);
      MAP.driving = new window.AMap.Driving({ map: MAP.map, policy: window.AMap.DrivingPolicy.LEAST_TIME });
      [["locNow", "now"], ["locPick", "pick"], ["locDest", "dest"]].forEach(function (p) {
        var ac = new window.AMap.AutoComplete({ input: p[0] });
        ac.on("select", function (e) {
          var loc = e && e.poi && e.poi.location;
          if (loc) { MAP.pts[p[1]] = loc; MAP.txt[p[1]] = $(p[0]).value; }
        });
        MAP.ac.push(ac);
      });
      var b = $("btnMapReload"); if (b) b.hidden = true;
      info("地图好了。点「定位」拿现在的位置，另外两个地点直接打字，从提示里点一条更准。");
      setTimeout(function () { try { MAP.map.resize(); } catch (e) {} }, 60);
    } catch (e) {
      info("地图初始化失败：" + esc(e && e.message ? e.message : e));
    }
  }

  /* ---------------- 定位 ---------------- */
  function locate(silent) {
    if (!window.isSecureContext) {
      // http 打开时浏览器直接不给位置，退回浏览器的原生定位再反查
      return nativeLocate(silent);
    }
    if (!MAP.geo) {
      if (silent) { nativeLocate(true); return; }
      // 地图还没好：先试试浏览器原生定位，能拿到就先填上
      nativeLocate(false);
      return;
    }
    info("在定位…");
    MAP.geo.getCurrentPosition(function (status, res) {
      var pos = res && res.position;
      if (status === "complete" && pos) {
        MAP.pts.now = pos;
        var shown = "当前位置 " + pos.lng.toFixed(4) + ", " + pos.lat.toFixed(4);
        $("locNow").value = shown;
        MAP.txt.now = shown;
        info("定位成功，接着填取货地和目的地。");
        new window.AMap.Geocoder().getAddress(pos, function (st, r) {
          var a = st === "complete" && r && r.regeocode && r.regeocode.formattedAddress;
          if (a) {
            $("locNow").value = a;
            MAP.txt.now = a;
            if (MAP.map) MAP.map.setCenter(pos);
          }
        });
      } else if (!silent) {
        nativeLocate(false);
      }
    });
  }

  /* 浏览器原生定位（不依赖高德插件），拿到坐标后再反查地名 */
  function nativeLocate(silent) {
    if (!navigator.geolocation) {
      if (!silent) info("这个浏览器不给位置，手动填个地名（比如「萧山区」）也能算。");
      return;
    }
    if (!silent) info("在定位（浏览器原生定位）…");
    navigator.geolocation.getCurrentPosition(function (pos) {
      var c = pos.coords;
      var p = { lng: c.longitude, lat: c.latitude };
      MAP.pts.now = p;
      var shown = "当前位置 " + c.longitude.toFixed(4) + ", " + c.latitude.toFixed(4);
      $("locNow").value = shown;
      MAP.txt.now = shown;
      info("定位成功，接着填取货地和目的地。");
      if (window.AMap) {
        new window.AMap.Geocoder().getAddress([c.longitude, c.latitude], function (st, r) {
          var a = st === "complete" && r && r.regeocode && r.regeocode.formattedAddress;
          if (a) {
            $("locNow").value = a;
            MAP.txt.now = a;
            var h = $("setHome");
            if (h && $("setHomeBtn") && $("setHomeBtn").dataset.filling === "1") h.value = a;
          }
        });
      }
    }, function (err) {
      if (silent) return;
      var why = err && err.code === 1
        ? "浏览器把这个网页的位置权限拒了。手机设置里给浏览器开「位置」，再点一次。"
        : (window.isSecureContext
          ? "定位超时或拿不到信号。到空旷点的地方再点，或者手动填个地名。"
          : "这个页面不是 https 打开的，浏览器不给位置。用 https 那个网址打开就能定位。");
      info(why);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  /* 设置页「用当前位置」：定位到了才回填，拿不到就一个字母都不动 */
  function useHere(cb) {
    var b = $("setHomeBtn");
    var h = $("setHome");
    if (b) { b.textContent = "定位中…"; b.disabled = true; }

    function done(cityText, err) {
      if (b) { b.disabled = false; b.textContent = "用当前位置"; }
      if (cityText) {
        if (typeof cb === "function") cb(cityText);
        else if (h) h.value = cityText;
        toast("已填上：" + cityText);
      } else {
        toast(err || "没拿到位置，原来的没动");
      }
    }

    if (!navigator.geolocation) { done(null, "这个浏览器不支持定位"); return; }
    if (!window.isSecureContext) {
      done(null, "这个页面不是 https，浏览器不给位置。用 https 那个网址打开");
      return;
    }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lng = pos.coords.longitude, lat = pos.coords.latitude;
      MAP.pts.now = { lng: lng, lat: lat };
      if (window.AMap) {
        new window.AMap.Geocoder().getAddress([lng, lat], function (st, r) {
          var g = st === "complete" && r && r.regeocode;
          var txt = "";
          if (g) {
            var ac = g.addressComponent || {};
            var city = String(ac.city || ac.province || "").replace(/市$/, "");
            var dist = String(ac.district || "").replace(/[区县市]$/, "");
            txt = city + dist;
            if (!txt && g.formattedAddress) txt = g.formattedAddress;
          }
          if (txt) done(txt);
          else if (g && g.formattedAddress) done(g.formattedAddress);
          else done(null, "定位到了但反查不出地名，手动填个大概");
        });
      } else {
        // 地图脚本还没加载：先把坐标填成地名框能用的形式
        done(null, "地名要多等地图加载完才能反查，稍后再点");
      }
    }, function (err) {
      var why = err && err.code === 1
        ? "你把这个网页的定位权限拒了。手机设置里给浏览器开「位置」再点"
        : "定位超时，到空旷地方再点，或者手动填";
      done(null, why);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  /* ---------------- 地理编码 / 路线 ---------------- */
  function ensurePoint(key, id, cb) {
    var el = $(id), text = (el.value || "").trim();
    if (!text) {
      if (key === "now") {
        // 没填现在的位置：让用户自己决定，不偷偷用别的东西
        toast("先点「定位」或者填一下你现在在哪");
        return;
      }
      toast("三个地点都填一下");
      return;
    }
    if (MAP.pts[key] && MAP.txt[key] === text) { cb(); return; }
    if (!window.AMap) { toast("地图还没加载好"); return; }
    new window.AMap.Geocoder().getLocation(text, function (status, result) {
      var g = result && result.geocodes;
      if (status === "complete" && g && g.length && g[0].location) {
        MAP.pts[key] = g[0].location;
        MAP.txt[key] = text;
        cb();
      } else {
        toast("没找到「" + text.slice(0, 8) + "」，在输入提示里点一条试试");
      }
    });
  }

  function driveOnce(a, b, cb) {
    var tries = 0;
    (function attempt() {
      var d;
      try {
        d = (tries === 0 && MAP.driving && !MAP.drivingBroken)
          ? MAP.driving
          : new window.AMap.Driving({ policy: window.AMap.DrivingPolicy.LEAST_TIME });
      } catch (e) { d = null; }
      if (!d) { cb("地图实例没准备好"); return; }
      try {
        d.search(a, b, function (st, res) {
          var r = st === "complete" && res && res.routes && res.routes[0];
          if (r) { cb(null, r); return; }
          var why = (res && (res.info || res.infocode)) || st || "未知原因";
          if (tries++ < 2) {
            if (!(res && (res.info || res.infocode))) MAP.drivingBroken = true;
            setTimeout(attempt, 700);
            return;
          }
          cb(String(why));
        });
      } catch (e) {
        if (tries++ < 2) { MAP.drivingBroken = true; setTimeout(attempt, 700); return; }
        cb("页面报错：" + (e && e.message ? e.message : e));
      }
    })();
  }

  function applyRoute(a, b) {
    var deadKm = Math.round(a.distance / 1000);
    var km = Math.round(b.distance / 1000);
    var toll = Math.round((a.tolls || 0) + (b.tolls || 0));

    // 关键：地图算出来的结果只放到「地图结果卡」里单独显示，
    // 绝不写进上面「粘贴算账」那套字段——两个功能彻底分开，互不覆盖。
    var show = window.TruckApp && window.TruckApp.showMapResult ? window.TruckApp.showMapResult : null;
    if (show) show({ dead: deadKm, km: km, toll: toll });

    info("空驶 <b>" + deadKm + " 公里</b>（约 " + dur(a.time) +
      "）· 载货 <b>" + km + " 公里</b>（约 " + dur(b.time) +
      "）· 过路费 <b>¥" + toll + "</b>，已经算在下面的「地图结果」里了。<br />" +
      "注意：高德按小客车算，货车跑得慢、过路费按轴收更高——时速还是按你自己的算，过路费要加可以在地图结果里改。");
    toast("路线算好了，看下面地图结果");
  }

  function runRoute() {
    if (!MAP.map) {
      if (window.AMap) initMap();
      toast("地图还在加载，等一下再点");
      return;
    }
    info("在算路线，稍等…");
    try { MAP.map.resize(); } catch (e) {}
    try { MAP.driving.clear(); } catch (e) {}

    // 三个框有值就先反推坐标，避免用户只是改了地名却还用旧点
    ensurePoint("now", "locNow", function () {
      ensurePoint("pick", "locPick", function () {
        ensurePoint("dest", "locDest", function () { compute(); });
      });
    });
  }

  function compute() {
    var A = ptArr(MAP.pts.now), B = ptArr(MAP.pts.pick), C = ptArr(MAP.pts.dest);
    if (!B || !C) {
      info("取货地或目的地还没定准，在输入框里的提示点一条更保险。");
      return;
    }
    if (!A) {
      info("没有「现在的位置」。点上面的「定位」拿一下，或者直接填个地名（比如「杭州萧山」）。");
      return;
    }
    driveOnce(A, B, function (e1, r1) {
      if (!r1) { failNow(e1); return; }
      driveOnce(B, C, function (e2, r2) {
        if (!r2) {
          info("取货地到目的地这段没算出来。<br />高德说的原因：<b>" + esc(e2) + "</b><br />" +
            "地点越具体越好（「广州白云机场国内货站」比「白云」好找），等一秒再点一次。");
          return;
        }
        applyRoute(r1, r2);
      });
    });
  }

  function failNow(msg) {
    info("现在到取货地这段没算出来。<br />高德说的原因：<b>" + esc(msg) + "</b><br />" +
      "多半是定位点它不认，或者网慢。把「现在的位置」改成一个地名（比如「杭州萧山」），再点一次。");
  }

  /* 设置页保存了新 Key，就把旧的地图整个丢掉重来 */
  function setKeys() {
    if (MAP.map) { try { MAP.map.destroy(); } catch (e) {} }
    MAP.map = null; MAP.geo = null; MAP.driving = null; MAP.drivingBroken = false;
    MAP.ac = []; MAP.pts = {}; MAP.txt = {}; MAP.loaded = false;
    var box = $("mapBox");
    if (box) box.innerHTML = "";
    if (window.AMap) { window.AMap = undefined; }
    // 卸载旧脚本，才能用新 Key 重新加载
    document.querySelectorAll('script[src*="webapi.amap.com/maps"]').forEach(function (x) { x.remove(); });
    load(true);
  }

  function isReady() { return !!MAP.map; }

  window.TruckMap = {
    load: load, locate: locate, useHere: useHere, runRoute: runRoute,
    setKeys: setKeys, isReady: isReady, pts: function () { return MAP.pts; }
  };
})();
