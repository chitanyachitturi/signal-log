import { fileURLToPath } from "node:url";
import { SETTINGS } from "./config.js";
import { fetchAllFeeds, getArticleText } from "./fetcher.js";
import { summarize } from "./summarizer.js";
import { knownKeys, addStories, urlKey } from "./store.js";

export const status = { running: false, lastRunAt: null, lastRunAdded: 0, lastError: null, nextRunAt: null };

/** One full cycle: read feeds → skip known articles → summarize new ones → save. */
export async function runRefresh() {
  if (status.running) return { skipped: true };
  status.running = true;
  status.lastError = null;
  const started = Date.now();
  try {
    const known = await knownKeys();
    const cutoff = Date.now() - SETTINGS.maxAgeDays * 864e5;
    const seen = new Set();
    const fresh = (await fetchAllFeeds())
      .filter(it => new Date(it.publishedAt).getTime() >= cutoff)
      .filter(it => { const k = urlKey(it.url); if (known.has(k) || seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, SETTINGS.maxNewPerRun);

    console.log(`[refresh] ${fresh.length} new article(s) to summarize`);
    const stories = [];
    // Small worker pool: 3 articles at a time
    const queue = [...fresh];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          const text = await getArticleText(item);
          const s = await summarize(item, text);
          if (!s.relevant) { console.log(`[refresh] skipped (not relevant): ${item.title}`); continue; }
          stories.push({
            id: Buffer.from(urlKey(item.url)).toString("base64url").slice(0, 40),
            url: item.url,
            source: item.source,
            originalTitle: item.title,
            publishedAt: item.publishedAt,
            fetchedAt: new Date().toISOString(),
            headline: s.headline,
            summary: s.summary,
            streams: s.streams,
            aiGenerated: s.aiGenerated,
          });
          console.log(`[refresh] + ${s.headline}`);
        } catch (e) {
          console.warn(`[refresh] failed on ${item.url}: ${e.message}`);
        }
      }
    }));

    const total = await addStories(stories, SETTINGS);
    status.lastRunAdded = stories.length;
    console.log(`[refresh] done in ${((Date.now() - started) / 1000).toFixed(1)}s — added ${stories.length}, total ${total}`);
    return { added: stories.length, total };
  } catch (e) {
    status.lastError = e.message;
    console.error("[refresh] error:", e);
    throw e;
  } finally {
    status.running = false;
    status.lastRunAt = new Date().toISOString();
  }
}

// `npm run refresh` runs a single cycle from the command line (handy for cron jobs)
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--once")) {
  runRefresh().then(r => { console.log(r); process.exit(0); }).catch(() => process.exit(1));
}
