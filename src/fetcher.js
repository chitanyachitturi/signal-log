import Parser from "rss-parser";
import * as cheerio from "cheerio";
import { FEEDS, SETTINGS } from "./config.js";

const parser = new Parser({
  timeout: SETTINGS.fetchTimeoutMs,
  headers: { "User-Agent": "SignalLog/1.0 (+personal news reader)" },
  customFields: { item: [["content:encoded", "contentEncoded"]] },
});

const clean = s => String(s || "").replace(/\s+/g, " ").trim();
const htmlToText = html => clean(cheerio.load(`<div>${html || ""}</div>`)("div").text());

// Resolve a possibly-relative image URL against the page URL; only keep http(s).
function absUrl(src, base) {
  try { const u = new URL(src, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

// Pull a lead image from a fetched page's <head>/<body>.
function pageImage($, base) {
  const metas = ["meta[property='og:image']", "meta[name='og:image']", "meta[property='og:image:url']", "meta[name='twitter:image']", "meta[name='twitter:image:src']"];
  for (const sel of metas) {
    const c = $(sel).attr("content");
    if (c) { const u = absUrl(c, base); if (u) return u; }
  }
  const link = $("link[rel='image_src']").attr("href");
  if (link) { const u = absUrl(link, base); if (u) return u; }
  // First reasonably large in-article image as a last resort.
  const img = $("article img, main img, img").filter((_, el) => {
    const w = Number($(el).attr("width")) || 0;
    return !$(el).attr("width") || w >= 200;
  }).first().attr("src");
  return img ? absUrl(img, base) : null;
}

/** Pull the newest items from every configured feed. A broken feed is logged and skipped. */
export async function fetchAllFeeds() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const items = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else console.warn(`[feeds] ${FEEDS[i].name} failed: ${r.reason?.message || r.reason}`);
  });
  return items;
}

// Pull an image URL from a feed item's various possible fields.
function feedImage(it) {
  const cand =
    it.enclosure?.url ||
    it["media:content"]?.$?.url ||
    it["media:thumbnail"]?.$?.url ||
    (Array.isArray(it["media:group"]?.["media:content"]) ? it["media:group"]["media:content"][0]?.$?.url : null);
  if (cand && /^https?:\/\//i.test(cand) && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(cand)) return cand;
  // Otherwise, grab the first <img> in the item's HTML content.
  const html = it.contentEncoded || it.content || it.summary || "";
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return m && /^https?:\/\//i.test(m[1]) ? m[1] : null;
}

async function fetchFeed(feed) {
  const parsed = await parser.parseURL(feed.url);
  const kw = (feed.keywords || []).map(k => k.toLowerCase());
  return (parsed.items || [])
    .map(it => ({
      url: it.link,
      title: clean(it.title),
      publishedAt: new Date(it.isoDate || it.pubDate || Date.now()).toISOString(),
      feedText: htmlToText(it.contentEncoded || it.content || it.summary || it.contentSnippet),
      image: feedImage(it),
      source: feed.name,
      stream: feed.stream,
    }))
    .filter(it => it.url && it.title)
    .filter(it => !kw.length || kw.some(k => new RegExp(`\\b${k}\\b`, "i").test(`${it.title} ${it.feedText}`)))
    .slice(0, feed.maxItems || 10);
}

/**
 * Get readable article text. Uses the feed's own content when it is long enough,
 * otherwise downloads the page and collects its paragraphs.
 */
export async function getArticleText(item) {
  // Even when the feed text is long enough, try to enrich a missing image cheaply.
  if (item.feedText.length > 1500 && item.image) return item.feedText.slice(0, SETTINGS.articleCharLimit);
  try {
    const res = await fetch(item.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalLog/1.0)" },
      signal: AbortSignal.timeout(SETTINGS.fetchTimeoutMs),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    // Prefer the page's social preview image; fall back to the first sizeable in-article <img>.
    if (!item.image) item.image = pageImage($, item.url);
    if (item.feedText.length > 1500) return item.feedText.slice(0, SETTINGS.articleCharLimit);
    $("script, style, nav, header, footer, aside, form, noscript").remove();
    const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
    const text = root.find("p, li, h2, h3").map((_, el) => clean($(el).text())).get()
      .filter(t => t.length > 40).join("\n");
    return (text.length > item.feedText.length ? text : item.feedText).slice(0, SETTINGS.articleCharLimit);
  } catch (e) {
    console.warn(`[article] ${item.url}: ${e.message} — using feed text`);
    return item.feedText.slice(0, SETTINGS.articleCharLimit);
  }
}
