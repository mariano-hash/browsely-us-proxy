// server.js — Browsely US Proxy (minimal safe + escaped-path recovery)
import express from "express";
import * as cheerio from "cheerio";
import cookieParser from "cookie-parser";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 8080;

const SHIM = readFileSync(join(__dirname, "runtime-shim.js"), "utf8");

app.disable("x-powered-by");
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Type"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "Browsely US Proxy", media: true })
);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function toAbs(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function proxyUrl(abs) {
  return `/proxy?url=${encodeURIComponent(abs)}`;
}

function assetUrl(abs) {
  return `/asset?url=${encodeURIComponent(abs)}`;
}

function setBaseCookie(res, targetUrl) {
  try {
    const u = new URL(targetUrl);
    const base = `${u.protocol}//${u.host}`;
    res.cookie("browsely_base", base, {
      httpOnly: false,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 1000 * 60 * 60 * 6
    });
  } catch {
    /* ignore */
  }
}

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;
    const abs = toAbs(baseUrl, href);
    if (abs) $(el).attr("href", proxyUrl(abs));
  });

  $("form").each((_, el) => {
    const $f = $(el);
    const method = ($f.attr("method") || "GET").toUpperCase();
    const action = $f.attr("action") || baseUrl;
    const abs = toAbs(baseUrl, action);
    if (!abs) return;

    if (method === "GET") {
      $f.attr("method", "POST");
      $f.attr("action", "/proxy");
      $f.prepend(`<input type="hidden" name="url" value="${abs}">`);
    } else {
      $f.attr("action", proxyUrl(abs));
    }
  });

  const assetSelectors = [
    ["img", "src"],
    ["video", "src"],
    ["audio", "src"],
    ["source", "src"],
    ["track", "src"],
    ["link", "href"],
    ["script", "src"]
  ];

  for (const [sel, attr] of assetSelectors) {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      const abs = toAbs(baseUrl, v);
      if (abs) $(el).attr(attr, assetUrl(abs));
    });
  }

  $("[srcset]").each((_, el) => {
    const v = $(el).attr("srcset");
    if (!v) return;
    const rewritten = v
      .split(",")
      .map((part) => {
        const [u, d] = part.trim().split(/\s+/, 2);
        const abs = toAbs(baseUrl, u);
        return abs ? `${assetUrl(abs)}${d ? " " + d : ""}` : part;
      })
      .join(", ");
    $(el).attr("srcset", rewritten);
  });

  const inject = `<script>window.__BROWSELY_BASE_URL__=${JSON.stringify(
    baseUrl
  )};</script><script>${SHIM}</script>`;

  if ($("head").length) {
    $("head").prepend(inject);
  } else {
    return inject + $.html();
  }

  return $.html();
}

async function handleProxy(req, res, targetUrl, extraQuery) {
  if (!targetUrl) return res.status(400).send("Missing url");

  let finalUrl;

  try {
    const u = new URL(targetUrl);

    if (extraQuery) {
      for (const [k, v] of Object.entries(extraQuery)) {
        if (k === "url") continue;
        u.searchParams.append(k, String(v));
      }
    }

    finalUrl = u.toString();
  } catch {
    return res.status(400).send("Invalid url");
  }

  setBaseCookie(res, finalUrl);

  try {
    const upstream = await fetch(finalUrl, {
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get("location");
      if (loc) {
        const abs = toAbs(finalUrl, loc);
        if (abs) return res.redirect(302, proxyUrl(abs));
      }
    }

    const ct = upstream.headers.get("content-type") || "";

    if (!/text\/html|application\/xhtml/i.test(ct)) {
      res.status(upstream.status);
      res.setHeader("Content-Type", ct || "application/octet-stream");
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.end(buf);
    }

    const html = await upstream.text();
    const rewritten = rewriteHtml(html, finalUrl);

    res.status(upstream.status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(rewritten);
  } catch (err) {
    console.error("[/proxy] error", err);
    return res.status(502).send("Proxy fetch failed");
  }
}

app.get("/proxy", (req, res) => {
  handleProxy(req, res, req.query.url, req.query);
});

app.post("/proxy", (req, res) => {
  const url = (req.body && req.body.url) || req.query.url;
  const extras = { ...(req.body || {}), ...(req.query || {}) };
  delete extras.url;
  handleProxy(req, res, url, extras);
});

app.get("/asset", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing url");

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": UA,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
        Referer: new URL(target).origin
      }
    });

    res.status(upstream.status);

    [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
      "last-modified",
      "etag"
    ].forEach((h) => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error("[/asset] error", err);
    res.status(502).send("Asset fetch failed");
  }
});

app.use((req, res, next) => {
  if (
    req.path === "/" ||
    req.path === "/health" ||
    req.path === "/proxy" ||
    req.path === "/asset"
  ) {
    return next();
  }

  const base = req.cookies && req.cookies.browsely_base;

  if (!base) {
    return res
      .status(400)
      .type("text/html")
      .send(
        `<h1>Browsely: lost context</h1>
         <p>Cannot resolve <code>${req.originalUrl}</code> — no proxied site is active.</p>
         <p>Open a URL through <code>/proxy?url=...</code> first.</p>`
      );
  }

  try {
    const abs = new URL(req.originalUrl, base).toString();
    return res.redirect(302, proxyUrl(abs));
  } catch {
    return res.status(400).send("Cannot reconstruct target URL");
  }
});

app.listen(PORT, () => {
  console.log(`Browsely proxy listening on :${PORT}`);
});
