import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Browsely US Proxy" });
});

function normalizeUrl(input) {
  if (!input) throw new Error("Missing URL");
  let url = input.trim();

  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  const parsed = new URL(url);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid protocol");
  }

  return parsed;
}

app.get("/proxy", async (req, res) => {
  try {
    const target = normalizeUrl(req.query.url);

    const response = await fetch(target.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 BrowselyProxy/1.0"
      },
      redirect: "follow"
    });

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      res.setHeader("content-type", contentType);
      response.body.pipe(res);
      return;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      try {
        const absolute = new URL(href, target.href).href;
        $(el).attr("href", `/proxy?url=${encodeURIComponent(absolute)}`);
      } catch {}
    });

    $("img[src], script[src], link[href]").each((_, el) => {
      const attr = $(el).attr("src") ? "src" : "href";
      const value = $(el).attr(attr);
      try {
        const absolute = new URL(value, target.href).href;
        $(el).attr(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
      } catch {}
    });

    res.setHeader("content-type", "text/html");
    res.send($.html());
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Browsely proxy running on port ${PORT}`);
});
