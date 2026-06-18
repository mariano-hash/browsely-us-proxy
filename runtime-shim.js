// runtime-shim.js
(function () {
  try {
    var BASE = (window.__BROWSELY__ && window.__BROWSELY__.base) || location.href;
    var b64u = function (s) {
      return btoa(unescape(encodeURIComponent(s)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    var abs = function (u) { try { return new URL(u, BASE).toString(); } catch (e) { return null; } };
    var skip = function (u) {
      return !u || /^(data:|blob:|javascript:|about:|mailto:|tel:|#|vbscript:)/i.test(String(u).trim());
    };
    var toDoc = function (u) {
      if (skip(u)) return u;
      var a = abs(u); return a ? "/p/" + b64u(a) : u;
    };
    var toAsset = function (u) {
      if (skip(u)) return u;
      var a = abs(u); return a ? "/a/" + b64u(a) : u;
    };

    // intercept clicks on links the rewriter may have missed (e.g. JS-built)
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      var href = a.getAttribute("href");
      if (skip(href)) return;
      if (/^\/(p|a)\//.test(href)) return;
      e.preventDefault();
      location.href = toDoc(href);
    }, true);

    // form submissions
    document.addEventListener("submit", function (e) {
      var f = e.target;
      if (!f || f.tagName !== "FORM") return;
      var action = f.getAttribute("action") || BASE;
      if (/^\/(p|a)\//.test(action)) return;
      var absAction = abs(action);
      if (!absAction) return;
      if ((f.method || "GET").toUpperCase() === "GET") {
        e.preventDefault();
        var params = new URLSearchParams(new FormData(f)).toString();
        var sep = absAction.indexOf("?") >= 0 ? "&" : "?";
        location.href = "/p/" + b64u(absAction + (params ? sep + params : ""));
      } else {
        f.setAttribute("action", "/p/" + b64u(absAction));
      }
    }, true);

    // location.assign / replace
    try {
      var _a = Location.prototype.assign, _r = Location.prototype.replace;
      Location.prototype.assign  = function (u) { return _a.call(this, toDoc(u)); };
      Location.prototype.replace = function (u) { return _r.call(this, toDoc(u)); };
    } catch (e) {}

    // window.open → same frame, proxied
    var _open = window.open;
    window.open = function (u, n, f) {
      try { u = toDoc(u); n = "_self"; } catch (e) {}
      return _open ? _open.call(window, u, n, f) : null;
    };
  } catch (e) {
    console.error("[Browsely shim] init failed", e);
  }
})();
