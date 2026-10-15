import { fileURLToPath } from "node:url";
import { SETTINGS } from "./config.js";
import { fetchAllFeeds, getArticleText } from "./fetcher.js";
import { summarize } from "./summarizer.js";
import { knownKeys, addStories, urlKey, titleTokens, titleSimilarity } from "./store.js";

export const status = {
  running: false, lastRunAt: null, lastRunAdded: 0, lastError: null,
  progress: { done: 0, total: 0, phase: "idle" }, // phase: idle | fetching | summarizing | saving | done
};

/** One full cycle: read feeds → skip known articles → summarize new ones → save. */
export async function runRefresh() {
  if (status.running) return { skipped: true };
  status.running = true;
  status.lastError = null;
  status.progress = { done: 0, total: 0, phase: "fetching" };
  const started = Date.now();
  try {
    const known = await knownKeys();
    const cutoff = Date.now() - SETTINGS.maxAgeDays * 864e5;
    const seen = new Set();
    const fresh = (await fetchAllFeeds())
      .filter(it => new Date(it.publishedAt).getTime() >= cutoff)
      .filter(it => { const k = urlKey(it.url); if (known.has(k) || seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt)); // oldest first: earliest becomes the group lead

    // Cheap pre-filter: group articles whose titles are similar (same story on
    // different sites) BEFORE summarizing, so each group costs one Claude call.
    // The earliest-published item leads; the rest ride along as extra sources.
    const groups = [];
    for (const it of fresh) {
      const tokens = titleTokens(it.title);
      const g = groups.find(x => titleSimilarity(tokens, x.tokens) >= SETTINGS.dedupeTitleThreshold);
      if (g) {
        g.sources.push({ source: it.source, url: it.url });
        console.log(`[dedupe] "${it.title}" (${it.source}) merged into "${g.lead.title}"`);
      } else {
        groups.push({ lead: it, tokens, sources: [{ source: it.source, url: it.url }] });
      }
    }
    // Newest groups first, capped per run.
    const picked = groups
      .sort((a, b) => new Date(b.lead.publishedAt) - new Date(a.lead.publishedAt))
      .slice(0, SETTINGS.maxNewPerRun);

    console.log(`[refresh] ${picked.length} new story group(s) to summarize (from ${fresh.length} article(s))`);
    status.progress = { done: 0, total: picked.length, phase: picked.length ? "summarizing" : "saving" };
    const stories = [];
    // Small worker pool: 3 groups at a time
    const queue = [...picked];
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const group = queue.shift();
        const item = group.lead;
        try {
          const text = await getArticleText(item);
          const s = await summarize(item, text);
          if (!s.relevant) { console.log(`[refresh] skipped (not relevant): ${item.title}`); continue; }
          stories.push({
            id: Buffer.from(urlKey(item.url)).toString("base64url").slice(0, 40),
            url: item.url,
            source: item.source,
            sources: group.sources, // every site that ran this story (for the Read-more links)
            originalTitle: item.title,
            publishedAt: item.publishedAt,
            fetchedAt: new Date().toISOString(),
            headline: s.headline,
            summary: s.summary,
            streams: s.streams,
            image: item.image || null,
            aiGenerated: s.aiGenerated,
          });
          console.log(`[refresh] + ${s.headline}${group.sources.length > 1 ? ` (${group.sources.length} sources)` : ""}`);
        } catch (e) {
          console.warn(`[refresh] failed on ${item.url}: ${e.message}`);
        } finally {
          status.progress.done++; // count every processed group so the bar completes
        }
      }
    }));

    status.progress.phase = "saving";
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
    status.progress.phase = "done";
  }
}

// `npm run refresh` runs a single cycle from the command line (handy for cron jobs)
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--once")) {
  runRefresh().then(r => { console.log(r); process.exit(0); }).catch(() => process.exit(1));
}
