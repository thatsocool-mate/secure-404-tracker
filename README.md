# secure-404-tracker

Nightly check for broken internal links on www.secure.com.

Every night at about 02:15 Karachi time, GitHub Actions runs `crawl.mjs`, which:

1. Reads robots.txt and every sitemap.
2. Opens every page in the sitemaps, plus every internal page linked from them (up to 5,000 pages).
3. Tests every internal link target, including PDFs and other files.
4. Records every internal URL that returns 404 or 410, with the pages that link to it and the link text.

Results are committed to `data/`:

| File | What it holds |
| --- | --- |
| `internal_404s.csv` | Every broken internal URL (state `New` or `Open`), plus URLs fixed in the last 30 days (`Fixed`) |
| `internal_404_runs.csv` | One row per night: pages crawled, links tested, broken, new, fixed |
| `state.json` | When each broken URL was first seen, and the fix log |
| `latest.json` | Summary of the last run |

The Secure.com positioning dashboard reads these files every morning and shows them on its **Internal 404s** tab.

## Running it by hand

Actions tab → "Daily internal 404 check" → Run workflow. Or locally: `node crawl.mjs` (Node 20+).

## If the run says "blocked"

Cloudflare challenged the crawler. Allow the user agent `Secure404Tracker/1.0` (or GitHub Actions IP ranges) in Cloudflare's WAF / bot rules.
