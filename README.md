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

## 1. Create the repo and turn on Pages

1. Create a new **public** GitHub repository (a free GitHub account can only
   serve Pages for free from a public repo).
2. Push everything in this folder to the repo's `main` branch.
3. In the repo, go to **Settings → Pages**, and under "Build and deployment"
   choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. After a minute your site is live at:
   `https://<your-username>.github.io/<repo-name>/`

Reading data works immediately with zero configuration — the site
auto-detects the owner and repo from that URL. Uploading needs the worker
below.

## 2. Deploy the upload proxy (Cloudflare Worker)

This is the one part that needs a human with an account — it's a five
minute job, and only needs doing once.

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
   if you don't have one.
2. Create a GitHub token the worker will use to write to this repo: go to
   <https://github.com/settings/personal-access-tokens/new>, set
   **"Repository access"** to **"Only select repositories"** → this repo,
   and under **"Permissions"** set **Contents** to **Read and write**
   (leave everything else as No access). This token is only ever pasted
   into Cloudflare in step 5 below — it never goes in this repo.
3. In `worker/wrangler.toml`, fill in `GITHUB_OWNER`, `GITHUB_REPO`, and
   `ALLOWED_ORIGIN` (your `https://<username>.github.io` origin — no
   trailing path).
4. From the `worker/` folder, run:
   ```bash
   npx wrangler login
   npx wrangler deploy
   ```
5. Set the GitHub token as a secret (you'll be prompted to paste it):
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
6. Wrangler prints the worker's URL (something like
   `https://bo-tracker-uploader.<your-subdomain>.workers.dev`). Paste it
   into `workerUrl` in [`js/config.js`](js/config.js), commit, and push.

That's it — from then on, anyone who visits the site can upload sessions
and leave notes with no setup at all.

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
