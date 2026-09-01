// Site-wide, non-secret configuration. Owner/repo/branch are auto-detected
// from the *.github.io hostname when this is deployed on GitHub Pages, so
// the fallbacks below are only used for local testing (file:// or a plain
// localhost server can't infer a repo from the URL).
//
// workerUrl points at the Cloudflare Worker that proxies uploads to GitHub
// (it holds the write token server-side — nothing secret lives in this
// file or anywhere else in this repo). Fill it in after deploying the
// worker; see README.md.

export const SITE_CONFIG = {
  workerUrl: 'https://bo-tracker-uploader.markwave01.workers.dev',
  fallbackOwner: 'JimBobSnow',
  fallbackRepo: 'Orderblock',
  fallbackBranch: 'main'
};
