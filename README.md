# Binary Options Strategy Tracker

A static site (hosted for free on **GitHub Pages**) for logging Binary
Options trades and backtests, tagging individual trades, and comparing
results. It uses **this GitHub repo itself as the database** — every
session, trade, tag, photo, and note is a file committed into the repo. A
small **Cloudflare Worker** does the actual writing on the site's behalf, so
anyone can browse and upload with zero login and zero setup — no GitHub
account, no token, nothing to configure.

## How it works

- **Trading Results** and **Backtesting Results** open straight to the feed
  of everyone's latest sessions. Click **+ Upload session** to log a new
  one: click **+ Add trade**, upload a screenshot, mark it Win or Loss, tag
  it, click **Complete trade** — repeat for each trade, then **Finish
  session**. The session's winrate and trade count are never typed in; they're
  always calculated from the trades you logged.
- Anyone can leave a note on any session from its **Notes** box.
- **Analytics** reads `data/trades.json` and `data/backtests.json` and
  shows winrate broken down by tag and by uploader, with a toggle between
  the two and a filter for trading vs. backtesting vs. both.
- Data lives in [`data/trades.json`](data/trades.json) and
  [`data/backtests.json`](data/backtests.json). Photos are committed into
  `images/trades/` and `images/backtests/`.
- The browser never talks to GitHub directly for writes. It calls the
  Cloudflare Worker in [`worker/`](worker/worker.js), which holds the one
  GitHub write token as a server-side secret and only ever allows writes to
  the two data files or a new image under `images/trades/` or
  `images/backtests/` — it can't touch the site's own code, and there's a
  hard size cap per file. See the comment at the top of
  [`worker/worker.js`](worker/worker.js) for the full threat model.

## Current deployment

This instance is already live:

- **Repo:** <https://github.com/JimBobSnow/Orderblock>
- **Site:** <https://jimbobsnow.github.io/Orderblock/> (deploys automatically
  on every push to `main` via [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) —
  check the repo's **Actions** tab for build status)
- **Worker:** `https://bo-tracker-uploader.markwave01.workers.dev`, already
  set in [`js/config.js`](js/config.js)

Reading data works with zero further setup. The one remaining step is
giving the worker a GitHub token so it can actually write — see below.

## Setting the worker's GitHub token

The worker needs a token scoped to **only this repo** to commit sessions,
photos, and notes on visitors' behalf. This is the one step that needs a
human, and only needs doing once:

1. Go to <https://github.com/settings/personal-access-tokens/new>
2. **Token name:** anything, e.g. `orderblock-uploader`
3. **Repository access:** "Only select repositories" → **Orderblock**
4. **Permissions → Repository permissions:** set **Contents** to
   **Read and write**. Leave everything else as No access.
5. Generate the token and copy it.
6. Set it as the worker's secret — from `worker/`, run:
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
   and paste the token when prompted (needs `CLOUDFLARE_API_TOKEN` set, or
   `wrangler login` completed, in that shell).

That's it — from then on, anyone who visits the site can upload sessions
and leave notes with no setup at all. If this token is ever compromised or
you want to rotate it, revoke it on GitHub and repeat these steps with a
fresh one — nothing else needs to change.

## Redeploying the worker after code changes

If `worker/worker.js` or `worker/wrangler.toml` changes, redeploy with:
```bash
cd worker && npx wrangler deploy
```
(The `GITHUB_TOKEN` secret survives redeploys — you only set it once.)

## Notes and limitations

- Uploaded photos are automatically resized (max 1600px) and re-compressed
  as JPEG before uploading, to keep the repo small and uploads fast.
- Two people saving at the same moment is handled with an automatic
  retry-on-conflict when writing to the shared JSON files, but this is a
  small-team tool, not built for high concurrency.
- Because uploading is open to anyone who can reach the site, there's no
  per-person attribution beyond whatever name someone types in — treat this
  like a shared whiteboard, not an audited ledger. If that ever becomes a
  problem, the worker is the one place to add a gate (e.g. a shared invite
  code) without touching the rest of the site.
- There's currently no way to edit or delete a session, trade, or note from
  the UI — that would need to be done by editing the files in the repo
  directly (or ask for that feature to be added).
- Newly uploaded photos are served from `raw.githubusercontent.com`, which
  can lag a few seconds behind a commit due to CDN caching — if a photo
  doesn't show up immediately, refresh in a bit.
- The trade tag presets are: `BOS`, `CHOCH`, `Support/Resistance`, `Swing`,
  `With trend`, `Against trend`. Anyone can add their own custom tags from
  the trade form, and those become filterable and show up in Analytics too.
