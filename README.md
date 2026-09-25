# Signal Log — AI & AWS news tracker

A self-hosted website that automatically collects AI and AWS news, uses Claude to write a headline and summary for each article, and shows them with a link to the full story. It refreshes itself on a schedule, and open browser tabs pick up new stories without reloading.

## Quick start

Requires Node.js 18.17 or newer.

```bash
npm install
cp .env.example .env        # then paste your ANTHROPIC_API_KEY into .env
npm start                   # open http://localhost:3000
```

On first start the server fetches all feeds and summarizes new articles (this takes a minute or two). After that it checks again every `REFRESH_MINUTES`.

Without an API key the site still works, but shows the original titles and a short preview instead of AI summaries.

## How it works

```
 RSS feeds ──► fetcher.js ──► skip already-stored URLs ──► get article text
                                                                │
 browser ◄── server.js /api ◄── data/stories.json ◄── summarizer.js (Claude)
   │  polls /api/status every 60 s
   └─ loads new stories automatically (or shows a "Show new stories" button if you're scrolled down)
```

| File | What it does |
| --- | --- |
| `src/config.js` | **Edit this first.** News feeds, keyword filters and settings. |
| `src/fetcher.js` | Reads RSS feeds and extracts article text. |
| `src/summarizer.js` | The Claude prompt that writes headlines and summaries, and tags each story AI and/or AWS. |
| `src/refresh.js` | One refresh cycle: fetch, dedupe, summarize, save. |
| `src/store.js` | Saves stories to `data/stories.json`. Removes duplicates and drops old stories. |
| `src/server.js` | Express server, API routes and the auto-refresh timer. |
| `public/` | The website (HTML, CSS, JS). No build step. |

## API

- `GET /api/stories?stream=ai|aws&q=bedrock&limit=50`: the stored stories, newest first
- `GET /api/status`: when the stories were last updated, and whether a refresh is running now
- `POST /api/refresh`: start a refresh right away. Limited to once every 2 minutes; needs the `x-admin-token` header if `ADMIN_TOKEN` is set.

## Customizing

- **Add a source:** add `{ name, url, stream, maxItems }` to `FEEDS` in `src/config.js`. For busy feeds, add `keywords: [...]` so only matching items are kept.
- **Change the summary style:** edit `PROMPT` in `src/summarizer.js`.
- **Control API cost:** each new article is one Claude call. `MAX_NEW_PER_RUN` caps how many are summarized per refresh. Already-stored articles are never summarized again.
- **Refresh from cron instead:** run `npm run refresh` to do one cycle and exit.

## Deploying on AWS

- **EC2 / Lightsail (simplest):** install Node, clone the repo, add `.env`, then run it with `pm2 start src/server.js --name signal-log` behind Nginx. `data/stories.json` stays on disk between restarts.
- **App Runner / ECS (container):** build the included `Dockerfile` and set the environment variables in the service. The container filesystem is temporary, so the feed rebuilds itself after each redeploy. For permanent history, mount EFS at `/app/data`, or replace `store.js` with DynamoDB or S3.
- Set `ADMIN_TOKEN` on any public deployment so strangers can't trigger refreshes that spend your API credits.

## Notes

- Feed URLs change now and then. If a feed breaks, the server logs `[feeds] <name> failed` and skips it; the other feeds keep working.
- Summaries are written in Claude's own words, and every story links to the original article.
