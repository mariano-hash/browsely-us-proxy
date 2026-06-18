// server.js — Browsely US Proxy (minimal safe navigation patch)
import express from "express";
import * as cheerio from "cheerio";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_SHIM = readFileSync(join(__dirname, "runtime-shim.js"), "utf8");

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS (open; tighten later if desired) ---
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Range, Accept, Accept-Language, User-Agent"
  );
  res.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Type"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Body parsing for POSTed forms (GET-form → POST conversion)
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

// --- Health ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "Browsely US Proxy", media: true });
});

// --- Helpers ---
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function buildForwardHeaders(req) {
  const h = {
    "user-agent": req.get("user-agent") || DEFAULT_UA,
    accept: req.get("accept") || "*/*",
    "accept-language": req.get("accept-language") || "en-US,en;q=0.9",
  };
  const range = req.get("range");
  if (range) h["range"] = range;
  return h;
}

function passthroughHeaders(srcHeaders, res) {
  const keep = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
    "cache-control",
    "etag",
    "last-modified",
  ];
  for (const k of keep) {
    const v = srcHeaders.get(k);
    if (v) res.set(k, v);
  }
}

function absolutize(target, base) {
  try {
    return new URL(target, base).href;
  } catch {
    return null;
  }
}

async function streamUpstream(upstream, res) {
  res.status(upstream.status);
  passthroughHeaders(upstream.headers, res);
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    /* client disconnected */
  }
  res.end();
}

// --- /asset — binary/media/css/js passthrough, preserves Range ---
app.get("/asset", async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== "string")
    return res.status(400).send("Missing url");
  try {
    const upstream = await fetch(url, {
      headers: buildForwardHeaders(req),
      redirect: "follow",
    });
    await streamUpstream(upstream, res);
  } catch (e) {
    res.status(502).send("Asset fetch failed: " + e.message);
  }
});

// --- /proxy — HTML pages (and any non-asset GET).
// Accepts GET ?url=... or POST (urlencoded) with `url` + extra form fields.
async function handleProxy(req, res) {
  let targetUrl = req.query.url || (req.body && req.body.url);
  if (!targetUrl)
    return res
      .status(400)
      .send("Cannot GET " + req.originalUrl + " — missing url parameter");

  // POST (converted GET form): append remaining body fields as query on target
  if (req.method === "POST" && req.body && typeof req.body === "object") {
    const extras = new URLSearchParams();
    for (const [k, v] of Object.entries(req.body)) {
      if (k === "url") continue;
      if (Array.isArray(v)) v.forEach((vv) => extras.append(k, String(vv)));
      else extras.append(k, String(v));
    }
    const qs = extras.toString();
    if (qs) targetUrl += (targetUrl.includes("?") ? "&" : "?") + qs;
  }

  // GET: forward extra query params (besides `url`) to target
  if (req.method === "GET") {
    const extras = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k === "url") continue;
      if (Array.isArray(v)) v.forEach((vv) => extras.append(k, String(vv)));
      else extras.append(k, String(v));
    }
    const qs = extras.toString();
    if (qs) targetUrl += (targetUrl.includes("?") ? "&" : "?") + qs;
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: buildForwardHeaders(req),
      redirect: "manual",
    });

    // Manual redirect: rewrite Location through /proxy
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get("location");
      if (loc) {
        const abs = absolutize(loc, targetUrl);
        if (abs) {
          res.redirect(
            upstream.status,
            "/proxy?url=" + encodeURIComponent(abs)
          );
          return;
        }
      }
    }

    const ctype = upstream.headers.get("content-type") || "";

    // Non-HTML → stream through
    if (!ctype.includes("text/html")) {
      await streamUpstream(upstream, res);
      return;
    }

    // HTML → rewrite + inject shim
    const html = await upstream.text();
    const rewritten = rewriteHtml(html, targetUrl);
    res.status(upstream.status);
    res.set("content-type", "text/html; charset=utf-8");
    res.send(rewritten);
  } catch (e) {
    res.status(502).send("Proxy fetch failed: " + e.message);
  }
}

app.get("/proxy", handleProxy);
app.post("/proxy", handleProxy);

// --- HTML rewriter ---
function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const toProxy = (u) => {
    const abs = absolutize(u, baseUrl);
    if (!abs) return u;
    return "/proxy?url=" + encodeURIComponent(abs);
  };
  const toAsset = (u) => {
    const abs = absolutize(u, baseUrl);
    if (!abs) return u;
    return "/asset?url=" + encodeURIComponent(abs);
  };

  // Links
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    )
      return;
    $(el).attr("href", toProxy(href));
  });

  // Media / assets
  $(
    "img[src], video[src], audio[src], source[src], track[src], script[src], iframe[src]"
  ).each((_, el) => {
    const src = $(el).attr("src");
    if (src) $(el).attr("src", toAsset(src));
  });
  $("video[poster]").each((_, el) => {
    const p = $(el).attr("poster");
    if (p) $(el).attr("poster", toAsset(p));
  });
  $("link[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) $(el).attr("href", toAsset(href));
  });
  $("[srcset]").each((_, el) => {
    const ss = $(el).attr("srcset");
    if (!ss) return;
    const out = ss
      .split(",")
      .map((part) => {
        const seg = part.trim().split(/\s+/);
        if (!seg[0]) return part;
        seg[0] = toAsset(seg[0]);
        return seg.join(" ");
      })
      .join(", ");
    $(el).attr("srcset", out);
  });

  // --- KEY FIX: forms ---
  // GET forms → POST /proxy with hidden `url`, so browser can't strip ?url=.
  // POST forms → action=/proxy?url=<absolute>
  $("form").each((_, el) => {
    const $f = $(el);
    const method = ($f.attr("method") || "GET").toUpperCase();
    const action = $f.attr("action") || baseUrl;
    const absAction = absolutize(action, baseUrl);
    if (!absAction) return;

    if (method === "GET") {
      $f.attr("method", "POST");
      $f.attr("action", "/proxy");
      $f.prepend(
        `<input type="hidden" name="url" value="${absAction.replace(
          /"/g,
          "&quot;"
        )}">`
      );
    } else {
      $f.attr("action", "/proxy?url=" + encodeURIComponent(absAction));
    }
  });

  // Inject base URL + runtime shim at top of <head>
  const shimTag =
    `<script>window.__BROWSELY_BASE_URL__=${JSON.stringify(baseUrl)};</script>` +
    `<script>${RUNTIME_SHIM}</script>`;

  if ($("head").length) {
    $("head").prepend(shimTag);
  } else {
    return shimTag + $.html();
  }

  return $.html();
}

app.listen(PORT, () => {
  console.log(`Browsely US Proxy listening on :${PORT}`);
});
