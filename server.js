import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

function normalizeUrl(input) {
  if (!input) throw new Error("Missing URL");

  let url = String(input).trim();

  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  const parsed = new URL(url);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("172.16.")
  ) {
    throw new Error("Blocked private/internal URL");
  }

  return parsed;
}

function proxifyUrl(url) {
  return `/proxy?url=${encodeURIComponent(url)}`;
}

function assetUrl(url) {
  return `/asset?url=${encodeURIComponent(url)}`;
}

function rewriteCssUrls(css, baseUrl) {
  return css.replace(/url\(([^)]+)\)/gi, (match, raw) => {
    let cleaned = raw.trim().replace(/^['"]|['"]$/g, "");

    if (
      cleaned.startsWith("data:") ||
      cleaned.startsWith("javascript:") ||
      cleaned.startsWith("#")
    ) {
      return match;
    }

    try {
      const absolute = new URL(cleaned, baseUrl).href;
      return `url("${assetUrl(absolute)}")`;
    } catch {
      return match;
    }
  });
}

function rewriteSrcset(value, baseUrl) {
  return value
    .split(",")
    .map((part) => {
      const pieces = part.trim().split(/\s+/);
      if (!pieces[0]) return part;

      try {
        const absolute = new URL(pieces[0], baseUrl).href;
        pieces[0] = assetUrl(absolute);
        return pieces.join(" ");
      } catch {
        return part;
      }
    })
    .join(", ");
}

function copyHeaders(from, to) {
  const allowed = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
    "cache-control",
    "last-modified",
    "etag"
  ];

  for (const header of allowed) {
    const value = from.headers.get(header);
    if (value) to.setHeader(header, value);
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Browsely US Proxy",
    media: true
  });
});

app.get("/asset", async (req, res) => {
  try {
    const target = normalizeUrl(req.query.url);

    const headers = {
      "User-Agent":
        req.headers["user-agent"] ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BrowselyProxy/1.0",
      Accept: req.headers.accept || "*/*"
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    if (req.headers["accept-language"]) {
      headers["Accept-Language"] = req.headers["accept-language"];
    }

    const response = await fetch(target.href, {
      headers,
      redirect: "follow"
    });

    res.status(response.status);
    copyHeaders(response, res);

    if (!res.getHeader("content-type")) {
      res.setHeader("content-type", "application/octet-stream");
    }

    response.body.pipe(res);
  } catch (err) {
    res.status(400).json({
      ok: false,
      route: "asset",
      error: err.message
    });
  }
});

app.get("/proxy", async (req, res) => {
  try {
    const target = normalizeUrl(req.query.url);

    const headers = {
      "User-Agent":
        req.headers["user-agent"] ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BrowselyProxy/1.0",
      Accept:
        req.headers.accept ||
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    };

    if (req.headers["accept-language"]) {
      headers["Accept-Language"] = req.headers["accept-language"];
    }

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const response = await fetch(target.href, {
      headers,
      redirect: "follow"
    });

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      res.status(response.status);
      copyHeaders(response, res);
      response.body.pipe(res);
      return;
    }

    let html = await response.text();
    const $ = cheerio.load(html);

    $("base").remove();

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");

      if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
        return;
      }

      try {
        const absolute = new URL(href, target.href).href;
        $(el).attr("href", proxifyUrl(absolute));
      } catch {}
    });

    $(
      "img[src], script[src], iframe[src], source[src], video[src], audio[src], track[src], embed[src], object[data]"
    ).each((_, el) => {
      const tag = el.tagName?.toLowerCase();
      const attr = tag === "object" ? "data" : "src";
      const value = $(el).attr(attr);

      if (!value || value.startsWith("data:") || value.startsWith("javascript:")) {
        return;
      }

      try {
        const absolute = new URL(value, target.href).href;
        $(el).attr(attr, assetUrl(absolute));
      } catch {}
    });

    $("link[href]").each((_, el) => {
      const href = $(el).attr("href");

      if (!href || href.startsWith("javascript:")) return;

      try {
        const absolute = new URL(href, target.href).href;
        $(el).attr("href", assetUrl(absolute));
      } catch {}
    });

    $("[srcset]").each((_, el) => {
      const srcset = $(el).attr("srcset");
      if (srcset) {
        $(el).attr("srcset", rewriteSrcset(srcset, target.href));
      }
    });

    $("[poster]").each((_, el) => {
      const poster = $(el).attr("poster");
      if (poster) {
        try {
          const absolute = new URL(poster, target.href).href;
          $(el).attr("poster", assetUrl(absolute));
        } catch {}
      }
    });

    $("form").each((_, el) => {
      $(el).attr("method", "GET");
      $(el).attr("action", proxifyUrl(target.href));
    });

    $("style").each((_, el) => {
      const css = $(el).html();
      if (css) {
        $(el).html(rewriteCssUrls(css, target.href));
      }
    });

    html = $.html();

    res.status(response.status);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    res.status(400).json({
      ok: false,
      route: "proxy",
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Browsely proxy running on port ${PORT}`);
});
