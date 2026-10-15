import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DATA_DIR, "stories.json");

let cache = null;

// Common words that carry no signal when comparing headlines.
const STOPWORDS = new Set("a an and are as at be by for from has have in is it its of on or that the to with how why what new will can you your".split(" "));

/** Reduce a title to a set of meaningful lowercase word tokens for comparison. */
export function titleTokens(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")   // drop punctuation
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

/**
 * Jaccard similarity (0-1) between two titles' token sets: shared words divided
 * by total distinct words. 1 = identical word sets, 0 = nothing in common.
 * Cheap, no API calls — used to catch the same story republished on other sites.
 */
export function titleSimilarity(a, b) {
  const ta = a instanceof Set ? a : titleTokens(a);
  const tb = b instanceof Set ? b : titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Normalize a URL so the same article from two feeds isn't stored twice. */
export function urlKey(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    [...x.searchParams.keys()].forEach(k => { if (/^(utm_|trk|sc_|nc\d?|ref$)/i.test(k)) x.searchParams.delete(k); });
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase();
  } catch { return String(u).toLowerCase(); }
}

export async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    cache = { updatedAt: null, stories: [] };
  }
  return cache;
}

export async function save(db) {
  cache = db;
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, FILE); // atomic replace
}

export async function knownKeys() {
  const db = await load();
  return new Set(db.stories.map(s => urlKey(s.url)));
}

/** Every source link attached to a story (always at least its own). */
function storySources(s) {
  if (Array.isArray(s.sources) && s.sources.length) return s.sources;
  return [{ source: s.source, url: s.url }];
}

/** Merge extra source links into a story, de-duplicating by URL. */
function mergeSources(into, from) {
  const seen = new Set(into.sources.map(x => urlKey(x.url)));
  for (const src of storySources(from)) {
    const k = urlKey(src.url);
    if (!seen.has(k)) { seen.add(k); into.sources.push(src); }
  }
}

/**
 * Add stories, drop old ones, keep newest first. Collapses near-duplicate
 * stories (same event on different sites) by URL and by title similarity,
 * keeping the earliest-published one and attaching the others as extra sources.
 */
export async function addStories(newStories, { maxAgeDays, maxStored, dedupeTitleThreshold = 0.6 }) {
  const db = await load();
  const cutoff = Date.now() - maxAgeDays * 864e5;

  // Oldest first so the earliest-published story becomes the primary of each group.
  const candidates = [...newStories, ...db.stories]
    .filter(s => new Date(s.publishedAt).getTime() >= cutoff)
    .sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

  const kept = [];
  const urlSeen = new Set();
  for (const s of candidates) {
    const k = urlKey(s.url);
    if (urlSeen.has(k)) {
      // Exact same URL already kept — fold its sources into that story.
      const owner = kept.find(o => o.sources.some(x => urlKey(x.url) === k));
      if (owner) mergeSources(owner, s);
      continue;
    }

    const tokens = titleTokens(s.headline || s.originalTitle);
    const dup = kept.find(o => titleSimilarity(tokens, o._tokens) >= dedupeTitleThreshold);
    if (dup) {
      mergeSources(dup, s);              // same story, different site
      urlSeen.add(k);
      continue;
    }

    const story = { ...s, sources: storySources(s), _tokens: tokens };
    urlSeen.add(k);
    kept.push(story);
  }

  // Newest first for display; strip the internal token cache before saving.
  const merged = kept
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, maxStored)
    .map(({ _tokens, ...s }) => s);

  await save({ updatedAt: new Date().toISOString(), stories: merged });
  return merged.length;
}
