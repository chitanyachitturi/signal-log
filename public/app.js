// Signal Log front end: renders stories and auto-refreshes by polling the server.
const POLL_MS = 60_000; // how often the browser checks for new stories

const $ = s => document.querySelector(s);
// category: "all" | "ai" | "aws"
const state = { category: "all", q: "", stories: [], updatedAt: null, freshIds: new Set(), pending: null };

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
    (state.category === "all" || s.streams.includes(state.category)) &&
    (!q || `${s.headline} ${s.summary} ${s.source}`.toLowerCase().includes(q)));
}

const timeOf = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const streamClass = s => (s.streams.length > 1 ? "both" : s.streams[0]);
const tagsHTML = s => s.streams.map(x => `<span class="tag ${x}">${x === "ai" ? "AI" : "AWS"}</span>`).join("");
const freshHTML = s => state.freshIds.has(s.id) ? `<span class="fresh-flag">New</span>` : "";
const readHTML = s => { const u = safeUrl(s.url); return u ? `<a class="read" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Read on ${esc(s.source)} <span aria-hidden="true">↗</span></a>` : ""; };

// Image, or a colored placeholder when the article had none.
function imageHTML(s, kind) {
  const cls = streamClass(s);
  const img = safeUrl(s.image);
  const inner = img
    ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.media').classList.add('noimg')">`
    : "";
  const label = s.streams.map(x => x === "ai" ? "AI" : "AWS").join(" · ");
  return `<div class="media ${cls}${img ? "" : " noimg"} media-${kind}">${inner}<span class="media-fallback" aria-hidden="true">${esc(label)}</span></div>`;
}

function render() {
  const list = visible();
  const feed = $("#feed");
  $("#count").textContent = state.stories.length
    ? `Showing ${list.length} of ${state.stories.length} stories`
    : "";

  if (!state.stories.length) { feed.innerHTML = `<p class="empty">No stories yet. The server is gathering the first batch — this page updates on its own.</p>`; return; }
  if (!list.length) {
    feed.innerHTML = `<p class="empty">No stories match this filter. Try “All”, or search a company or service name like Bedrock or Gemini.</p>`;
    return;
  }

  // Group by local day, newest first.
  const groups = new Map();
  for (const s of list) {
    const key = new Date(s.publishedAt).toLocaleDateString("en-CA"); // local YYYY-MM-DD
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  let first = true;
  feed.innerHTML = [...groups].map(([key, items]) => {
    const d = new Date(key + "T12:00:00");
    const label = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    let html = `<section class="section"><div class="section-head"><h2>${esc(label)}</h2></div>`;
    if (first) {
      // Newest day: every story shown large, landscape-style.
      html += `<div class="leads">${items.map(heroHTML).join("")}</div>`;
      first = false;
    } else {
      // Older days: compact card grid.
      html += `<div class="grid">${items.map(cardHTML).join("")}</div>`;
    }
    return html + `</section>`;
  }).join("");
}

function heroHTML(s) {
  const cls = streamClass(s);
  return `<article class="hero ${cls}">
    <div class="accent ${cls}"></div>
    <div class="hero-grid">
      <div class="hero-body">
        <div class="kicker">${tagsHTML(s)}<span class="source">${esc(s.source)}</span><span class="dot-sep">${esc(timeOf(s.publishedAt))}</span>${freshHTML(s)}</div>
        <h3>${esc(s.headline)}</h3>
        <p class="ai-note">${s.aiGenerated ? "AI summary" : "Preview (AI summaries are off)"}</p>
        <p class="summary">${esc(s.summary)}</p>
        ${readHTML(s)}
      </div>
      ${imageHTML(s, "hero")}
    </div>
  </article>`;
}

function cardHTML(s) {
  const cls = streamClass(s);
  return `<article class="card ${cls}">
    <div class="accent ${cls}"></div>
    ${imageHTML(s, "card")}
    <div class="card-body">
      <div class="meta">${tagsHTML(s)}<span class="source">${esc(s.source)}</span><span class="dot-sep">${esc(timeOf(s.publishedAt))}</span>${freshHTML(s)}</div>
      <h3>${esc(s.headline)}</h3>
      <p class="ai-note">${s.aiGenerated ? "AI summary" : "Preview"}</p>
      <p class="summary">${esc(s.summary)}</p>
      ${readHTML(s)}
    </div>
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
function setCategory(c) {
  state.category = c;
  document.querySelectorAll(".cat").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.c === c)));
  const sel = $("#catSelect");
  if (sel.value !== c) sel.value = c;
  render();
}

document.querySelectorAll(".cat").forEach(b =>
  b.addEventListener("click", () => setCategory(b.dataset.c)));
$("#catSelect").addEventListener("change", e => setCategory(e.target.value));

let qT; $("#q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { state.q = e.target.value; render(); }, 120); });

// ---------- Start ----------
$("#dateline").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
$("#year").textContent = new Date().getFullYear();
loadStories().catch(() => {}).finally(poll);
setInterval(poll, POLL_MS);
setInterval(paintStatus, 30_000); // keep "updated X min ago" current
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
