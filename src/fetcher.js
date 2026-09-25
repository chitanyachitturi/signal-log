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

async function fetchFeed(feed) {
  const parsed = await parser.parseURL(feed.url);
  const kw = (feed.keywords || []).map(k => k.toLowerCase());
  return (parsed.items || [])
    .map(it => ({
      url: it.link,
      title: clean(it.title),
      publishedAt: new Date(it.isoDate || it.pubDate || Date.now()).toISOString(),
      feedText: htmlToText(it.contentEncoded || it.content || it.summary || it.contentSnippet),
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
  if (item.feedText.length > 1500) return item.feedText.slice(0, SETTINGS.articleCharLimit);
  try {
    const res = await fetch(item.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SignalLog/1.0)" },
      signal: AbortSignal.timeout(SETTINGS.fetchTimeoutMs),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
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
