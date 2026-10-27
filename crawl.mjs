// Daily internal 404 check for www.secure.com.
// Crawls every page in the sitemaps plus every internal page linked from them,
// checks every internal link target, and records which ones return 404 or 410.
// Output: data/internal_404s.csv, data/internal_404_runs.csv, data/state.json, data/latest.json
import fs from 'node:fs';

const ORIGIN = process.env.ORIGIN || 'https://www.secure.com';
const BASE = new URL(ORIGIN);
const HOSTS = new Set([BASE.host, BASE.host.replace(/^www\./, ''), ...(process.env.EXTRA_HOSTS ? process.env.EXTRA_HOSTS.split(',') : [])]);
const MAX_PAGES = Number(process.env.MAX_PAGES || 5000);
const CONC = Number(process.env.CONCURRENCY || 6);
const UA = process.env.UA || 'Secure404Tracker/1.0 (daily internal link check; contact: seo@secure.com)';
const DATA = process.env.DATA_DIR || 'data';
const TZ = 'Asia/Karachi';
const SKIP_CRAWL = /\.(pdf|png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|zip|mp4|webm|mp3|woff2?|ttf|eot)$/i;
const BROKEN = new Set([404, 410]);
// Not real links: Cloudflare's email-protection and other /cdn-cgi/ paths only work in a browser
const EXCLUDE = /^\/cdn-cgi\//;

const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(href, base) {
  if (!href) return null;
  href = href.trim();
  if (/^(mailto:|tel:|javascript:|data:|#)/i.test(href)) return null;
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !HOSTS.has(u.host)) return null;
  u.protocol = BASE.protocol; u.host = BASE.host; u.hash = ''; u.search = '';
  if (EXCLUDE.test(u.pathname)) return null;
  return u.toString();
}
const pathOf = (u) => { const x = new URL(u); return x.pathname || '/'; };

async function get(url, method = 'GET') {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { method, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, signal: AbortSignal.timeout(30000) });
      if ((res.status === 429 || res.status >= 500) && i < 2) { await sleep(2000 * (i + 1)); continue; }
      return res;
    } catch (e) { if (i === 2) return { status: 0, ok: false, error: String(e && e.message || e), headers: new Headers(), text: async () => '' }; await sleep(2000 * (i + 1)); }
  }
}

async function sitemapUrls() {
  const seen = new Set(); const pages = new Set();
  const queue = [ORIGIN + '/sitemap.xml'];
  try { const r = await get(ORIGIN + '/robots.txt'); if (r.ok) (await r.text()).split('\n').forEach((l) => { const m = l.match(/^\s*sitemap:\s*(\S+)/i); if (m) queue.push(m[1]); }); } catch {}
  while (queue.length) {
    const sm = queue.shift(); if (seen.has(sm)) continue; seen.add(sm);
    const r = await get(sm); if (!r || !r.ok) continue;
    const xml = await r.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(xml)) locs.forEach((l) => queue.push(l));
    else locs.forEach((l) => { const n = norm(l, ORIGIN); if (n) pages.add(n); });
  }
  return pages;
}

const decode = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
function links(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const h = m[1].match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i); if (!h) continue;
    const u = norm(h[2] ?? h[3] ?? h[4], base); if (!u) continue;
    let text = decode(m[2]); if (!text) { const al = m[1].match(/aria-label\s*=\s*"([^"]*)"/i) || m[2].match(/alt\s*=\s*"([^"]*)"/i); text = al ? al[1] : '(image or icon link)'; }
    out.push([u, text.slice(0, 90)]);
  }
  return out;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const started = new Date();
  const status = new Map();          // url -> http status
  const sources = new Map();         // target url -> Map(source path -> anchor)
  const inSitemap = await sitemapUrls();
  const queue = [ORIGIN + '/', ...inSitemap]; const queued = new Set(queue);
  let crawled = 0; let runStatus = 'ok'; let note = '';

  const home = await get(ORIGIN + '/');
  if (!home || home.status === 403 || home.status === 503 || home.status === 0) {
    const body = home && home.text ? await home.text() : '';
    runStatus = 'blocked'; note = `Homepage returned ${home ? home.status : 'no response'}${/cloudflare|cf-chl|challenge/i.test(body) ? ' (Cloudflare challenge)' : ''}. Allow this crawler's user agent in Cloudflare.`;
  }

  let active = 0;
  async function worker() {
    while (runStatus === 'ok' && crawled < MAX_PAGES) {
      if (!queue.length) { if (!active) break; await sleep(200); continue; }
      const url = queue.shift(); crawled++; active++;
      try { await visit(url); } finally { active--; }
    }
  }
  async function visit(url) {
      const r = await get(url); status.set(url, r.status);
      const ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
      if (!r.ok || !/html/i.test(ct)) return;
      const html = await r.text(); const src = pathOf(url);
      for (const [t, text] of links(html, r.url || url)) {
        if (!sources.has(t)) sources.set(t, new Map());
        const m = sources.get(t); if (!m.has(src)) m.set(src, text);
        if (!queued.has(t) && !SKIP_CRAWL.test(new URL(t).pathname)) { queued.add(t); queue.push(t); }
      }
      await sleep(150);
  }
  if (runStatus === 'ok') await Promise.all(Array.from({ length: CONC }, worker));

  // Check every linked target that was not fetched as a page (files, or past the page cap)
  const toCheck = [...sources.keys()].filter((u) => !status.has(u));
  let i = 0;
  async function checker() { while (i < toCheck.length) { const u = toCheck[i++]; let r = await get(u, 'HEAD'); if (r.status === 405 || r.status === 403 || r.status === 0) r = await get(u); status.set(u, r.status); await sleep(100); } }
  if (runStatus === 'ok') await Promise.all(Array.from({ length: CONC }, checker));

  const broken = [...status].filter(([u, s]) => BROKEN.has(s) && (sources.has(u) || inSitemap.has(u))).map(([u]) => u);

  // State: first_seen per broken URL, and a log of fixes
  const statePath = `${DATA}/state.json`;
  const firstRun = !fs.existsSync(statePath);
  const state = firstRun ? { open: {}, fixed: [] } : JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const u of Object.keys(state.open)) if (EXCLUDE.test(new URL(u).pathname)) delete state.open[u];
  const prev = { ...state.open };
  if (runStatus === 'ok') {
    const nowOpen = {};
    for (const u of broken) nowOpen[u] = { first_seen: (state.open[u] && state.open[u].first_seen) || today };
    for (const [u, v] of Object.entries(state.open)) if (!nowOpen[u]) {
      const how = status.has(u) && !BROKEN.has(status.get(u)) ? `Now returns ${status.get(u)}` : 'No longer linked';
      state.fixed.push({ url: u, first_seen: v.first_seen, fixed_on: today, how });
    }
    const cutoff = new Date(Date.now() - 30 * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
    state.fixed = state.fixed.filter((f) => f.fixed_on >= cutoff);
    state.open = nowOpen;
  }

  const q = (v) => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const rows = [['url', 'path', 'status', 'state', 'first_seen', 'last_seen', 'days_open', 'source_count', 'in_sitemap', 'sources', 'fixed_on', 'how_fixed']];
  for (const [u, v] of Object.entries(state.open)) {
    const src = sources.get(u) || new Map();
    const list = [...src].slice(0, 25).map(([p, t]) => `${p} » ${t}`).join(' | ');
    const isNew = !firstRun && !(u in prev);
    rows.push([u, pathOf(u), status.get(u) ?? '', isNew ? 'New' : 'Open', v.first_seen, today, days(v.first_seen, today), src.size, inSitemap.has(u) ? 'Yes' : 'No', list, '', '']);
  }
  for (const f of state.fixed) rows.push([f.url, pathOf(f.url), '', 'Fixed', f.first_seen, f.fixed_on, days(f.first_seen, f.fixed_on), 0, '', '', f.fixed_on, f.how]);
  if (runStatus === 'ok') fs.writeFileSync(`${DATA}/internal_404s.csv`, rows.map((r) => r.map(q).join(',')).join('\n') + '\n');

  const runsPath = `${DATA}/internal_404_runs.csv`;
  const head = 'date,run_at,status,pages_crawled,links_checked,broken,new,fixed,note\n';
  let runs = fs.existsSync(runsPath) ? fs.readFileSync(runsPath, 'utf8') : head;
  const lines = runs.trim().split('\n').filter((l, k) => k === 0 || !l.startsWith(today + ','));
  const nNew = firstRun ? 0 : Object.keys(state.open).filter((u) => !(u in prev)).length;
  const nFixed = state.fixed.filter((f) => f.fixed_on === today).length;
  lines.push([today, started.toISOString(), firstRun && runStatus === 'ok' ? 'baseline' : runStatus, crawled, sources.size, Object.keys(state.open).length, nNew, nFixed, note].map(q).join(','));
  fs.writeFileSync(runsPath, lines.slice(0, 1).concat(lines.slice(1).slice(-120)).join('\n') + '\n');
  if (runStatus === 'ok') fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  fs.writeFileSync(`${DATA}/latest.json`, JSON.stringify({ date: today, run_at: started.toISOString(), status: firstRun && runStatus === 'ok' ? 'baseline' : runStatus, note, pages_crawled: crawled, links_checked: sources.size, broken: Object.keys(state.open).length, new: nNew, fixed: nFixed }, null, 1));
  console.log(`${today} ${runStatus}: crawled ${crawled} pages, ${sources.size} internal links, ${Object.keys(state.open).length} broken (${nNew} new, ${nFixed} fixed). ${note}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
