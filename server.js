// server.js — Browsely US Proxy (path-based context, no cookies)
import express from "express";
import * as cheerio from "cheerio";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIM = readFileSync(join(__dirname, "runtime-shim.js"), "utf8");

const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

// ---------- helpers ----------
const b64uEncode = (s) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDecode = (s) => {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf8");
};

const toAbs = (base, val) => {
  try { return new URL(val, base).toString(); } catch { return null; }
};
const isSkippable = (v) =>
  !v || /^(data:|blob:|javascript:|about:|mailto:|tel:|#|vbscript:)/i.test(v.trim());

const proxyPath = (abs) => `/p/${b64uEncode(abs)}`;
const assetPath = (abs) => `/a/${b64uEncode(abs)}`;

// Try to recover target from a "referer" header (escaped path case)
function recoverFromReferer(req) {
  const ref = req.get("referer");
  if (!ref) return null;
  try {
    const u = new URL(ref);
    const m = u.pathname.match(/^\/(p|a)\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const refTarget = b64uDecode(m[2]);
    return toAbs(refTarget, req.originalUrl);
  } catch { return null; }
}

// ---------- health ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "Browsely US Proxy", media: true })
);
app.get("/", (_req, res) =>
  res.type("text/plain").send("Browsely US Proxy — use /p/<base64url(target)>")
);

// ---------- legacy compat: /proxy?url=... → /p/<b64> ----------
app.get("/proxy", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing ?url=");
  return res.redirect(302, proxyPath(String(url)));
});
app.post("/proxy", (req, res) => {
  const url = req.body?.url || req.query?.url;
  if (!url) return res.status(400).send("Missing url");
  return res.redirect(302, proxyPath(String(url)));
});

// ---------- HTML rewriter ----------
function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // kill CSP / meta-refresh that could escape proxy
  $('meta[http-equiv="content-security-policy" i]').remove();
  $('meta[http-equiv="refresh" i]').remove();
  $("base").remove();

  // force same-frame nav
  $("a[target], form[target], area[target], base[target]").removeAttr("target");

  // remove SRI (we change bytes)
  $("[integrity]").removeAttr("integrity");
  $("[crossorigin]").removeAttr("crossorigin");
  $("[nonce]").removeAttr("nonce");

  const rwAsset = (val) => {
    if (isSkippable(val)) return val;
    const abs = toAbs(baseUrl, val);
    return abs ? assetPath(abs) : val;
  };
  const rwDoc = (val) => {
    if (isSkippable(val)) return val;
    const abs = toAbs(baseUrl, val);
    return abs ? proxyPath(abs) : val;
  };

  // assets
  ["src", "poster", "data", "background", "formaction"].forEach((attr) => {
    $(`[${attr}]`).each((_, el) => {
      const v = $(el).attr(attr);
      if (v) $(el).attr(attr, rwAsset(v));
    });
  });

  // srcset
  $("[srcset]").each((_, el) => {
    const v = $(el).attr("srcset");
    if (!v) return;
    $(el).attr(
      "srcset",
      v.split(",").map((p) => {
        const t = p.trim().split(/\s+/);
        if (!t[0]) return p;
        const abs = toAbs(baseUrl, t[0]);
        return abs ? [assetPath(abs), ...t.slice(1)].join(" ") : p;
      }).join(", ")
    );
  });

  // href / action — depends on tag
  $("a[href], area[href]").each((_, el) => {
    const v = $(el).attr("href");
    if (v) $(el).attr("href", rwDoc(v));
  });
  $("link[href]").each((_, el) => {
    const v = $(el).attr("href");
    if (v) $(el).attr("href", rwAsset(v));
  });
  $("form").each((_, el) => {
    const v = $(el).attr("action") || baseUrl;
    $(el).attr("action", rwDoc(v));
  });

  // inject runtime shim with the base
  const shimCfg = `<script>window.__BROWSELY__=${JSON.stringify({ base: baseUrl })};</script>`;
  const shimTag = `<script>${SHIM}</script>`;
  const head = $("head");
  if (head.length) head.prepend(shimCfg + shimTag);
  else $.root().prepend("<head>" + shimCfg + shimTag + "</head>");

  return $.html();
}

// ---------- fetch + stream helper ----------
async function fetchUpstream(targetUrl, req) {
  const headers = {
    "user-agent":
      req.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "accept": req.get("accept") || "*/*",
    "accept-language": req.get("accept-language") || "en-US,en;q=0.9",
  };
  const range = req.get("range");
  if (range) headers["range"] = range;
  const referer = req.get("referer");
  if (referer) {
    try {
      const u = new URL(referer);
      const m = u.pathname.match(/^\/(p|a)\/([A-Za-z0-9_-]+)/);
      if (m) headers["referer"] = b64uDecode(m[2]);
    } catch {}
  }
  return fetch(targetUrl, { headers, redirect: "manual" });
}

function passResponseHeaders(upstream, res) {
  const drop = new Set([
    "content-encoding", "content-length", "transfer-encoding",
    "content-security-policy", "content-security-policy-report-only",
    "x-frame-options", "strict-transport-security",
    "cross-origin-opener-policy", "cross-origin-embedder-policy",
    "cross-origin-resource-policy",
  ]);
  upstream.headers.forEach((v, k) => {
    if (!drop.has(k.toLowerCase())) res.setHeader(k, v);
  });
}

// ---------- /p/:b64 — document proxy ----------
app.all(/^\/p\/([A-Za-z0-9_-]+)$/, async (req, res) => {
  let target;
  try { target = b64uDecode(req.params[0]); new URL(target); }
  catch { return res.status(400).send("Bad target"); }

  try {
    const upstream = await fetchUpstream(target, req);

    // follow redirects, re-wrapping the Location
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get("location")) {
      const next = toAbs(target, upstream.headers.get("location"));
      if (next) return res.redirect(302, proxyPath(next));
    }

    const ct = upstream.headers.get("content-type") || "";
    passResponseHeaders(upstream, res);
    res.status(upstream.status);

    if (ct.includes("text/html")) {
      const body = await upstream.text();
      const html = rewriteHtml(body, target);
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.send(html);
    }
    // non-HTML doc response — stream through
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  } catch (e) {
    return res.status(502).send("Upstream error: " + e.message);
  }
});

// ---------- /a/:b64 — asset proxy (with Range) ----------
app.all(/^\/a\/([A-Za-z0-9_-]+)$/, async (req, res) => {
  let target;
  try { target = b64uDecode(req.params[0]); new URL(target); }
  catch { return res.status(400).send("Bad asset"); }
  try {
    const upstream = await fetchUpstream(target, req);
    passResponseHeaders(upstream, res);
    res.status(upstream.status);
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    res.status(502).send("Asset error: " + e.message);
  }
});

// legacy alias
app.all("/asset", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing ?url=");
  return res.redirect(302, assetPath(String(url)));
});

// ---------- catch-all: escaped paths ----------
// e.g. browser hits /search/milf directly; rebuild target from Referer.
app.all("*", (req, res) => {
  const recovered = recoverFromReferer(req);
  if (recovered) return res.redirect(302, proxyPath(recovered));
  res
    .status(404)
    .type("text/html")
    .send(
      `<h1>Browsely: lost context</h1>
       <p>Cannot resolve <code>${req.originalUrl.replace(/</g, "&lt;")}</code>.</p>
       <p>Open a site via <code>/p/&lt;base64url(target)&gt;</code> first.</p>`
    );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Browsely proxy on :${PORT}`));
