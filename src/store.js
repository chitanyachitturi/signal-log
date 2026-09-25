import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DATA_DIR, "stories.json");

let cache = null;

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

/** Add stories, drop old ones, keep newest first. */
export async function addStories(newStories, { maxAgeDays, maxStored }) {
  const db = await load();
  const cutoff = Date.now() - maxAgeDays * 864e5;
  const seen = new Set();
  const merged = [...newStories, ...db.stories]
    .filter(s => {
      const k = urlKey(s.url);
      if (seen.has(k)) return false;
      seen.add(k);
      return new Date(s.publishedAt).getTime() >= cutoff;
    })
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, maxStored);
  await save({ updatedAt: new Date().toISOString(), stories: merged });
  return merged.length;
}
