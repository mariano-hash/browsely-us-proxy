(function () {
  if (window.__BROWSELY_SHIM_INSTALLED__) return;
  window.__BROWSELY_SHIM_INSTALLED__ = true;

  var BASE = window.__BROWSELY_BASE_URL__ || location.href;
  var ORIGIN = location.origin;

  function isInternal(u) {
    if (!u) return true;
    if (u.indexOf(ORIGIN + "/proxy") === 0) return true;
    if (u.indexOf(ORIGIN + "/asset") === 0) return true;
    if (u.indexOf("/proxy?") === 0 || u === "/proxy") return true;
    if (u.indexOf("/asset?") === 0 || u === "/asset") return true;
    if (u.charAt(0) === "#") return true;
    if (u.indexOf("javascript:") === 0) return true;
    if (u.indexOf("mailto:") === 0) return true;
    if (u.indexOf("tel:") === 0) return true;
    if (u.indexOf("data:") === 0) return true;
    if (u.indexOf("blob:") === 0) return true;
    return false;
  }

  function toProxy(u) {
    try {
      if (u == null) return u;
      var s = String(u);
      if (isInternal(s)) return s;
      var abs = new URL(s, BASE).href;
      return "/proxy?url=" + encodeURIComponent(abs);
    } catch (e) {
      return u;
    }
  }

  // --- Click delegation: catches <a> added by JS after page load ---
  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return; // left click only
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var t = e.target;
      var a = t && t.closest ? t.closest("a[href]") : null;
      if (!a) return;
      var href = a.getAttribute("href");
      if (!href || isInternal(href)) return;
      var target = a.getAttribute("target");
      if (target && target !== "_self") return; // _blank etc. flows through window.open
      e.preventDefault();
      window.location.href = toProxy(href);
    },
    true
  );

  // --- Submit delegation: catches GET forms created by JS ---
  document.addEventListener(
    "submit",
    function (e) {
      var f = e.target;
      if (!f || f.tagName !== "FORM") return;
      var method = (f.getAttribute("method") || "GET").toUpperCase();
      if (method !== "GET") return; // POST forms already rewritten server-side
      var action = f.getAttribute("action") || BASE;
      if (isInternal(action)) return;
      try {
        var abs = new URL(action, BASE).href;
        f.setAttribute("method", "POST");
        f.setAttribute("action", "/proxy");
        if (!f.querySelector('input[name="url"]')) {
          var hidden = document.createElement("input");
          hidden.type = "hidden";
          hidden.name = "url";
          hidden.value = abs;
          f.insertBefore(hidden, f.firstChild);
        }
      } catch (err) {
        /* let it submit as-is */
      }
    },
    true
  );

  // --- Location.assign / Location.replace ---
  try {
    var origAssign = Location.prototype.assign;
    var origReplace = Location.prototype.replace;
    Location.prototype.assign = function (u) {
      return origAssign.call(this, toProxy(u));
    };
    Location.prototype.replace = function (u) {
      return origReplace.call(this, toProxy(u));
    };
  } catch (e) {}

  // --- location.href setter (best-effort) ---
  try {
    var desc = Object.getOwnPropertyDescriptor(Location.prototype, "href");
    if (desc && desc.configurable && desc.set) {
      var origSet = desc.set;
      Object.defineProperty(Location.prototype, "href", {
        configurable: true,
        enumerable: true,
        get: desc.get,
        set: function (v) {
          return origSet.call(this, toProxy(v));
        },
      });
    }
  } catch (e) {}

  // --- window.open ---
  try {
    var origOpen = window.open;
    window.open = function (u, name, features) {
      return origOpen.call(window, u ? toProxy(u) : u, name, features);
    };
  } catch (e) {}
})();
