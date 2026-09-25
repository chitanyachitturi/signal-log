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
// Light background check: refresh the status line, and pick up new stories if a
// refresh finished elsewhere (e.g. another tab). Does NOT trigger new refreshes.
async function poll() {
  if (refreshing) return; // the watcher owns polling while a refresh runs
  try {
    const st = await (await fetch("/api/status")).json();
    lastStatus = st;
    paintStatus();
    if (st.updatedAt && st.updatedAt !== state.updatedAt) {
      if (window.scrollY > 400 && state.stories.length) {
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
  el.innerHTML = st.refreshing
    ? `<span class="dot"></span>Fetching the latest news…`
    : st.lastError
      ? `Last check failed: ${esc(st.lastError)}`
      : `<span class="dot"></span>Updated ${ago(st.updatedAt)}`;
  $("#refreshBtn").disabled = st.refreshing;
}

// ---------- Progress loader ----------
const PHASE_LABEL = {
  fetching: "Checking sources for the latest news…",
  summarizing: "Summarizing new articles with AI…",
  saving: "Almost done — saving stories…",
  done: "Up to date.",
  idle: "Checking sources for the latest news…",
};

function showLoader() {
  $("#loader").classList.remove("hidden");
  $("#refreshBtn").disabled = true;
}
function hideLoader() {
  $("#loader").classList.add("hidden");
  $("#progressFill").classList.remove("indeterminate");
  $("#progressFill").style.width = "0%";
}
function paintLoader(st) {
  const fill = $("#progressFill");
  const p = st.progress || { done: 0, total: 0, phase: "fetching" };
  $("#loaderLabel").textContent = PHASE_LABEL[p.phase] || PHASE_LABEL.fetching;
  if (p.total > 0) {
    fill.classList.remove("indeterminate");
    fill.style.width = Math.round((p.done / p.total) * 100) + "%";
    $("#loaderSub").textContent = `${p.done} of ${p.total} articles`;
  } else {
    // No count yet (still fetching feeds): show an indeterminate sweep.
    fill.classList.add("indeterminate");
    $("#loaderSub").textContent = "";
  }
}

// Trigger a refresh and watch it to completion, driving the progress bar.
let refreshing = false;
async function triggerRefresh({ manual = false } = {}) {
  if (refreshing) return;
  const headers = {};
  const token = sessionStorage.getItem("adminToken");
  if (token) headers["x-admin-token"] = token;

  const res = await fetch("/api/refresh", { method: "POST", headers });
  if (res.status === 401) {
    if (manual) {
      const t = prompt("Enter your admin token to refresh:");
      if (t) { sessionStorage.setItem("adminToken", t); return triggerRefresh({ manual }); }
    }
    return; // no token on an automatic load: just show cached stories
  }
  // 200/202 = started (or already running); 429 = refreshed very recently. Either way, watch progress.
  refreshing = true;
  showLoader();
  await watchRefresh();
}

// Poll status until the refresh finishes, then load the fresh stories.
async function watchRefresh() {
  try {
    while (true) {
      const st = await (await fetch("/api/status")).json();
      lastStatus = st;
      paintStatus();
      paintLoader(st);
      if (!st.refreshing) break;
      await new Promise(r => setTimeout(r, 1200));
    }
    // Fill to 100% briefly, then swap in the results.
    $("#progressFill").classList.remove("indeterminate");
    $("#progressFill").style.width = "100%";
    await new Promise(r => setTimeout(r, 350));
    await loadStories({ markNew: state.stories.length > 0 });
  } catch {
    $("#status").className = "status-line err";
    $("#status").textContent = "Can't reach the server. Retrying…";
  } finally {
    refreshing = false;
    hideLoader();
    paintStatus();
  }
}

$("#newPill").addEventListener("click", async () => {
  $("#newPill").classList.add("hidden");
  await loadStories({ markNew: true });
  window.scrollTo({ top: $("#feed").offsetTop - 20, behavior: "smooth" });
});

$("#refreshBtn").addEventListener("click", () => triggerRefresh({ manual: true }));

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

async function boot() {
  // Show whatever we have cached right away.
  await loadStories().catch(() => {});
  // Then ask the server whether the news is stale; if so, refresh on this visit.
  try {
    const st = await (await fetch("/api/status")).json();
    lastStatus = st;
    paintStatus();
    if (st.stale) {
      await triggerRefresh();          // on-load refresh (only when older than the staleness window)
    }
  } catch {
    // Server unreachable: leave cached stories on screen; the poller will retry.
  }
}
boot();

setInterval(poll, POLL_MS);            // light background sync (no new refreshes)
setInterval(paintStatus, 30_000);      // keep "updated X min ago" current
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
