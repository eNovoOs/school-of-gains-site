import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Mirror the entire School of Gains site (all internal pages on the apex domain)
// into static HTML at build time. Internal links are rewritten to stay on the
// mirror; external links (Whop, papergains.shop, tools/portfolio subdomains,
// social, embeds) are left untouched.

const ORIGIN = 'https://school-of-gains.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Known entry points from the nav + footer; the crawler discovers the rest.
const SEEDS = [
  '/home-page',
  '/apprentice',
  '/master',
  '/discord-community',
  '/about',
  '/newsletter',
  '/special-offer-general',
  '/privacy-page',
  '/terms-page'
];

const ASSET_RE = /\.(png|jpe?g|svg|webp|gif|css|mjs|js|ico|mp4|webm|woff2?|ttf|pdf|json|xml|txt)$/i;

function normalizePath(href) {
  try {
    const u = new URL(href, ORIGIN);
    if (u.hostname !== 'school-of-gains.com') return null; // apex only, no subdomains
    let p = u.pathname;
    if (ASSET_RE.test(p)) return null;
    p = p.replace(/\/+$/, '');
    return p === '' ? '/home-page' : p;
  } catch {
    return null;
  }
}

const queue = [...new Set(SEEDS)];
const visited = new Set();
const pages = new Map(); // path -> raw html

while (queue.length && visited.size < 80) {
  const p = queue.shift();
  if (visited.has(p)) continue;
  visited.add(p);

  let html;
  try {
    const res = await fetch(ORIGIN + p, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
    });
    if (!res.ok) {
      console.log('skip', p, res.status);
      continue;
    }
    html = await res.text();
  } catch (e) {
    console.log('error', p, e.message);
    continue;
  }

  pages.set(p, html);

  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const np = normalizePath(m[1]);
    if (np && !visited.has(np) && !queue.includes(np)) queue.push(np);
  }
}

if (pages.size === 0) {
  throw new Error('No pages fetched — aborting build.');
}

function rewrite(html) {
  return html
    .replaceAll('https://www.school-of-gains.com', '')
    .replaceAll('https://school-of-gains.com', '')
    .replaceAll('href=""', 'href="/"');
}

await mkdir('public', { recursive: true });

for (const [p, raw] of pages) {
  const rel = p.replace(/^\//, '');
  const file = path.join('public', rel + '.html');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rewrite(raw));
  console.log('wrote', file);
}

// Serve the home page at the site root too.
const home = pages.get('/home-page');
if (home) await writeFile('public/index.html', rewrite(home));

console.log('Mirrored pages:', pages.size);
