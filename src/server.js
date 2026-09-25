import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS, FEEDS } from "./config.js";
import { load } from "./store.js";
import { runRefresh, status } from "./refresh.js";

const app = express();
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(PUBLIC));

// All stored stories, newest first. Optional ?stream=ai|aws&q=text&limit=n
app.get("/api/stories", async (req, res) => {
  const db = await load();
  let list = db.stories;
  const { stream, q } = req.query;
  if (stream === "ai" || stream === "aws") list = list.filter(s => s.streams.includes(stream));
  if (q) { const t = String(q).toLowerCase(); list = list.filter(s => `${s.headline} ${s.summary} ${s.source}`.toLowerCase().includes(t)); }
  const limit = Math.min(Number(req.query.limit) || 300, 600);
  res.json({ updatedAt: db.updatedAt, count: list.length, stories: list.slice(0, limit) });
});

// Lightweight endpoint the browser polls to know when new stories exist
app.get("/api/status", async (_req, res) => {
  const db = await load();
  res.json({
    updatedAt: db.updatedAt,
    count: db.stories.length,
    refreshing: status.running,
    lastRunAt: status.lastRunAt,
    lastRunAdded: status.lastRunAdded,
    nextRunAt: status.nextRunAt,
    lastError: status.lastError,
    refreshMinutes: SETTINGS.refreshMinutes,
    aiSummaries: SETTINGS.hasApiKey,
    feeds: FEEDS.length,
  });
});

// "Refresh now" button. Throttled; optionally protected by ADMIN_TOKEN.
let lastManual = 0;
app.post("/api/refresh", (req, res) => {
  if (SETTINGS.adminToken && req.get("x-admin-token") !== SETTINGS.adminToken)
    return res.status(401).json({ error: "Admin token required" });
  if (status.running) return res.status(202).json({ started: false, message: "Already refreshing" });
  if (Date.now() - lastManual < 2 * 60e3) return res.status(429).json({ error: "Refreshed less than 2 minutes ago" });
  lastManual = Date.now();
  runRefresh().catch(() => {}); // runs in background; clients see it via /api/status
  res.status(202).json({ started: true });
});

// ---- Auto-refresh scheduler ----
const intervalMs = SETTINGS.refreshMinutes * 60e3;
function schedule() {
  status.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  setTimeout(async () => { await runRefresh().catch(() => {}); schedule(); }, intervalMs);
}

app.listen(SETTINGS.port, async () => {
  console.log(`Signal Log running at http://localhost:${SETTINGS.port}`);
  console.log(`Checking ${FEEDS.length} feeds every ${SETTINGS.refreshMinutes} min · AI summaries: ${SETTINGS.hasApiKey ? SETTINGS.model : "OFF (set ANTHROPIC_API_KEY)"}`);
  const db = await load();
  const stale = !db.updatedAt || Date.now() - new Date(db.updatedAt) > intervalMs;
  if (stale) runRefresh().catch(() => {}); // fill the feed on first start
  schedule();
});
