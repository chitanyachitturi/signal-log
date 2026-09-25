# Signal Log — AI & AWS news tracker

A self-hosted website that automatically collects AI and AWS news, uses Claude to write a headline and summary for each article, and shows them with a link to the full story. It refreshes itself on a schedule, and open browser tabs pick up new stories without reloading.

## Quick start

Requires Node.js 18.17 or newer.

```bash
npm install
cp .env.example .env        # then paste your ANTHROPIC_API_KEY into .env
npm start                   # open http://localhost:3000
```

See [`.env.example`](.env.example) for every setting and what it does. At minimum, set
`ANTHROPIC_API_KEY`; set `ADMIN_TOKEN` too if you plan to host this publicly.

**Refreshes happen on demand, not on a timer.** When someone opens the site and the stored
news is older than `REFRESH_MINUTES` (default 30), the page triggers a refresh and shows a
progress bar while the server fetches feeds and summarizes new articles. If the news is still
fresh, the page loads instantly from cache and does nothing. This means the app can run on a
free host that sleeps when idle — a visit wakes it and pulls the latest news.

Without an API key the site still works, but shows the original titles and a short preview instead of AI summaries.

## How it works

```
 visitor opens site ──► browser checks /api/status
   │                        │
   │           news fresh? ─┴─ news stale (>REFRESH_MINUTES)?
   │              │                      │
   │        show cached          POST /api/refresh ──► fetcher.js ──► summarizer.js (Claude)
   │        stories now                  │                                    │
   └────────────────────────────────────┴──► progress bar polls /api/status ──┘
                                              (done/total) until finished, then
                                              loads the new data/stories.json
```

| File | What it does |
| --- | --- |
| `src/config.js` | **Edit this first.** News feeds, keyword filters and settings. |
| `src/fetcher.js` | Reads RSS feeds, extracts article text, and picks a lead image (feed media or the page's `og:image`). |
| `src/summarizer.js` | The Claude prompt that writes headlines and summaries, and tags each story AI and/or AWS. |
| `src/refresh.js` | One refresh cycle: fetch, dedupe, summarize, save. |
| `src/store.js` | Saves stories to `data/stories.json`. Removes duplicates and drops old stories. |
| `src/server.js` | Express server and API routes. No background timer — refreshes are triggered on demand by the browser. |
| `public/` | The website (HTML, CSS, JS). No build step. |

## API

- `GET /api/stories?stream=ai|aws&q=bedrock&limit=50`: the stored stories, newest first
- `GET /api/status`: when the stories were last updated, whether the news is `stale`, whether a refresh is `refreshing` now, and live `progress` (`{done, total, phase}`) that drives the progress bar.
- `POST /api/refresh`: start a refresh right away. Triggered automatically by the browser when the news is stale, or manually by the Refresh button. Limited to once every 2 minutes; needs the `x-admin-token` header if `ADMIN_TOKEN` is set.

## Customizing

- **Add a source:** add `{ name, url, stream, maxItems }` to `FEEDS` in `src/config.js`. For busy feeds, add `keywords: [...]` so only matching items are kept.
- **Change the summary style:** edit `PROMPT` in `src/summarizer.js`.
- **Control API cost:** each new article is one Claude call. `MAX_NEW_PER_RUN` caps how many are summarized per refresh. Already-stored articles are never summarized again.
- **Refresh from cron / manually:** run `npm run refresh` to do one cycle and exit (handy for a scheduled job, or to pre-fill the cache before deploying).
- **Change the staleness window:** set `REFRESH_MINUTES`. Smaller = fresher news but more on-load refreshes (and API calls); larger = faster loads, older news.

## Deploying

This is a Node server (Express) that fetches and summarizes news on demand. It needs a
host that runs Node, but it does **not** need to stay awake — there's no background timer,
so a free host that sleeps when idle is fine. A visitor's request wakes it, it serves cached
news instantly, and refreshes only if the news is stale. It will **not** work on static-only
hosts like GitHub Pages (no server to run the fetch + your API key must stay server-side).

Because it tolerates sleeping, the easiest free options are **Render's free web service**
or **Google Cloud Run** (both sleep when idle and wake on a request). For always-on free,
an **Oracle Cloud Free Tier** VM works too (see Option 3).

### Before you deploy (applies to every option)

1. **Set your secrets as environment variables on the host — never commit `.env`.**
   The two that matter:
   - `ANTHROPIC_API_KEY` — enables AI summaries (the site runs without it, showing previews).
   - `ADMIN_TOKEN` — **set this on any public deployment** so strangers can't trigger
     refreshes that spend your API credits. Generate one with `openssl rand -hex 32`.
2. `.env` is gitignored on purpose. Confirm it is not staged (`git status`) before any commit.
3. Storage note: `data/stories.json` lives on the container/VM disk. On hosts with an
   ephemeral filesystem the feed simply rebuilds itself after each redeploy — fine for a
   personal reader. For permanent history, attach a persistent volume mounted at `/app/data`.

### Option 1 — Fly.io (recommended; already configured)

The repo ships a `fly.toml` (app `signal-log`, internal port `3000`) and a GitHub Actions
workflow at `.github/workflows/fly-deploy.yml`.

**Deploy directly from your machine:**

```bash
brew install flyctl                 # once
fly auth login                      # once
fly secrets set ANTHROPIC_API_KEY=sk-ant-...    # stored encrypted on Fly
fly secrets set ADMIN_TOKEN=your-random-token
fly deploy                          # builds the Dockerfile and ships
fly open                            # open the live site
```

**Or deploy automatically on every push to `main`:**

1. Create a deploy token: `fly tokens create deploy -x 999999h`
2. In GitHub → Settings → Secrets and variables → Actions, add it as `FLY_API_TOKEN`.
3. Set the app secrets once with `fly secrets set ...` (as above).
4. Push to `main`. The workflow runs `flyctl deploy` for you.

**Persistent history (optional):** create a volume and mount it, so stories survive redeploys:

```bash
fly volumes create signal_data --size 1
```

Then add to `fly.toml`:

```toml
[mounts]
  source = "signal_data"
  destination = "/app/data"
```

### Option 2 — Any container host (App Runner, ECS, Render, Railway)

Build the included `Dockerfile` and set `ANTHROPIC_API_KEY` and `ADMIN_TOKEN` in the
service's environment settings.

```bash
docker build -t signal-log .
docker run -p 3000:3000 --env-file .env signal-log   # local test
```

The container filesystem is temporary, so the feed rebuilds after each redeploy. For
permanent history, mount a persistent volume at `/app/data` (e.g. EFS on ECS), or replace
`src/store.js` with DynamoDB or S3.

### Option 3 — A small VM (EC2, Lightsail, DigitalOcean)

Simplest way to keep history on disk permanently:

```bash
npm install --omit=dev
npm install -g pm2
pm2 start src/server.js --name signal-log
pm2 save && pm2 startup           # restart on reboot
```

Put Nginx in front for port 80/443 and TLS. `data/stories.json` persists across restarts.

## Notes

- Feed URLs change now and then. If a feed breaks, the server logs `[feeds] <name> failed` and skips it; the other feeds keep working.
- Summaries are written in Claude's own words, and every story links to the original article.
