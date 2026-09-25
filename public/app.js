// Signal Log front end: renders stories and auto-refreshes by polling the server.
const POLL_MS = 60_000; // how often the browser checks for new stories

const $ = s => document.querySelector(s);
const state = { on: { ai: true, aws: true }, q: "", stories: [], updatedAt: null, freshIds: new Set(), pending: null };

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
function ago(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} d ago`;
}

// ---------- Rendering ----------
function visible() {
  const q = state.q.trim().toLowerCase();
  return state.stories.filter(s =>
    s.streams.some(x => state.on[x]) &&
    (!q || `${s.headline} ${s.summary} ${s.source}`.toLowerCase().includes(q)));
}

function render() {
  const list = visible();
  $("#count").textContent = `${list.length} of ${state.stories.length} stories showing.`;
  const feed = $("#feed");
  if (!state.stories.length) { feed.innerHTML = `<p class="empty">No stories yet. The server is gathering the first batch — this page updates on its own.</p>`; return; }
  if (!list.length) {
    feed.innerHTML = `<p class="empty">${state.on.ai || state.on.aws ? "No stories match that search. Try a company or service name, like Bedrock or Gemini." : "Both streams are switched off. Tap AI or AWS above to bring stories back."}</p>`;
    return;
  }
  const groups = new Map();
  for (const s of list) {
    const key = new Date(s.publishedAt).toLocaleDateString("en-CA"); // local YYYY-MM-DD
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  feed.innerHTML = [...groups].map(([key, items]) => {
    const d = new Date(key + "T12:00:00");
    return `<section class="day">
      <div class="day-label"><div class="dow">${d.toLocaleDateString("en-US", { weekday: "long" })}</div>
      <div class="dm">${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })}</div></div>
      <div>${items.map(storyHTML).join("")}</div></section>`;
  }).join("");
}

function storyHTML(s) {
  const cls = s.streams.length > 1 ? "both" : s.streams[0];
  const url = safeUrl(s.url);
  const fresh = state.freshIds.has(s.id) ? " fresh" : "";
  return `<article class="story ${cls}${fresh}">
    <div class="meta">${s.streams.map(x => `<span class="tag ${x}">${x === "ai" ? "AI" : "AWS"}</span>`).join("")}
      <span>${esc(s.source)}</span><span>${esc(new Date(s.publishedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}</span></div>
    <h3>${esc(s.headline)}</h3>
    <p class="ai-note">${s.aiGenerated ? "AI summary" : "Preview (AI summaries are off)"}</p>
    <p class="summary">${esc(s.summary)}</p>
    ${url ? `<a class="read" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Read the full story on ${esc(s.source)} <span aria-hidden="true">↗</span></a>` : ""}
  </article>`;
}

// ---------- Data + auto-refresh ----------
async function loadStories({ markNew = false } = {}) {
  const res = await fetch("/api/stories");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (markNew) {
    const old = new Set(state.stories.map(s => s.id));
    data.stories.forEach(s => { if (!old.has(s.id)) state.freshIds.add(s.id); });
  }
  state.stories = data.stories;
  state.updatedAt = data.updatedAt;
  render();
}

let lastStatus = null;
async function poll() {
  try {
    const st = await (await fetch("/api/status")).json();
    lastStatus = st;
    paintStatus();
    if (st.updatedAt && st.updatedAt !== state.updatedAt) {
      // If the reader is scrolled down, don't move the page under them — offer a button instead.
      if (window.scrollY > 400 && state.stories.length) {
        state.pending = st.updatedAt;
        $("#newPill").classList.remove("hidden");
      } else {
        await loadStories({ markNew: state.stories.length > 0 });
      }
    }
  } catch {
    $("#status").className = "status-line err";
    $("#status").textContent = "Can't reach the server. Retrying…";
  }
}

function paintStatus() {
  const st = lastStatus; if (!st) return;
  const el = $("#status");
  el.className = "status-line" + (st.refreshing ? " busy" : "") + (st.lastError ? " err" : "");
  const next = st.nextRunAt ? new Date(st.nextRunAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "soon";
  el.innerHTML = st.refreshing
    ? `<span class="dot"></span>Checking ${st.feeds} sources for new stories…`
    : st.lastError
      ? `Last check failed: ${esc(st.lastError)}`
      : `<span class="dot"></span>Updated ${ago(st.updatedAt)} · next check ${next}`;
  $("#refreshBtn").disabled = st.refreshing;
}

$("#newPill").addEventListener("click", async () => {
  $("#newPill").classList.add("hidden");
  await loadStories({ markNew: true });
  window.scrollTo({ top: $("#feed").offsetTop - 20, behavior: "smooth" });
});

$("#refreshBtn").addEventListener("click", async () => {
  const headers = {};
  const token = sessionStorage.getItem("adminToken");
  if (token) headers["x-admin-token"] = token;
  const res = await fetch("/api/refresh", { method: "POST", headers });
  if (res.status === 401) {
    const t = prompt("Enter your admin token to refresh:");
    if (t) { sessionStorage.setItem("adminToken", t); $("#refreshBtn").click(); }
    return;
  }
  if (res.status === 429) { alert("The feed was refreshed less than 2 minutes ago. Try again shortly."); return; }
  setTimeout(poll, 1500);
  // Poll faster while a refresh runs
  const fast = setInterval(async () => { await poll(); if (!lastStatus?.refreshing) clearInterval(fast); }, 5000);
});

// ---------- Filters ----------
document.querySelectorAll(".stream").forEach(b => b.addEventListener("click", () => {
  const s = b.dataset.s, other = s === "ai" ? "aws" : "ai";
  if (state.on[s] && state.on[other]) state.on[other] = false;       // isolate this stream
  else if (state.on[s] && !state.on[other]) state.on[other] = true;  // back to both
  else state.on[s] = true;
  document.querySelectorAll(".stream").forEach(x => x.setAttribute("aria-pressed", String(state.on[x.dataset.s])));
  render();
}));
let qT; $("#q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { state.q = e.target.value; render(); }, 120); });

// ---------- Start ----------
loadStories().catch(() => {}).finally(poll);
setInterval(poll, POLL_MS);
setInterval(paintStatus, 30_000); // keep "updated X min ago" current
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
