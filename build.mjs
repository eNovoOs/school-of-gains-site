import { mkdir, writeFile, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';

// Old School of Gains logo assets to swap for the new PaperGains logo.
const OLD_LOGOS = [
  'https://assets.cdn.filesafe.space/3mi3YQaZvtUMZzaQUuL6/media/69c3581dab2203884982a7c7.svg',
  'https://assets.cdn.filesafe.space/3mi3YQaZvtUMZzaQUuL6/media/69655d38f8a93b75c306981f.png'
];
const NEW_LOGO = '/logo.png';

// Mirror the entire School of Gains site (all internal pages on the apex domain)
// into static HTML at build time. Internal links are rewritten to stay on the
// mirror; external links (Whop, papergains.shop, tools/portfolio subdomains,
// social, embeds) are left untouched.

const ORIGIN = 'https://school-of-gains.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Known entry points from the nav + footer; the crawler discovers the rest.
const SEEDS = [
  // Home-page nav/footer slug family
  '/home-page',
  '/apprentice',
  '/master',
  '/discord-community',
  '/about',
  '/newsletter',
  '/special-offer-general',
  '/privacy-page',
  '/terms-page',
  // Pages not linked from the home nav (found via GHL Sites list)
  '/contact',
  '/nfp-indicator',
  // Alternate slug family used by the Contact page nav/footer
  '/home',
  '/apprentice-of-gains',
  '/discord',
  '/about-us',
  '/privacy-policy',
  '/terms',
  // Discord + 7 Free Lessons opt-in funnel (not linked from site nav)
  '/discord-free-lessons',
  '/discord-free-lessons-thank-you'
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

// Injected into every page. GoHighLevel's runtime JS rewrites anchor hrefs back
// to absolute school-of-gains.com URLs, so we intercept clicks in the capture
// phase and keep same-apex navigation on this mirror. Subdomains and external
// links pass through untouched.
const INJECT = `\n<script src="/join/attribution.js"></script>\n<script>(function(){var LOGO='/logo.png';var IDS=['69c3581dab2203884982a7c7','69655d38f8a93b75c306981f'];function fixLogos(){var im=document.getElementsByTagName('img');for(var i=0;i<im.length;i++){var s=im[i].getAttribute('src')||'';for(var j=0;j<IDS.length;j++){if(s.indexOf(IDS[j])>-1){im[i].src=LOGO;break;}}}}fixLogos();document.addEventListener('DOMContentLoaded',fixLogos);var n=0,iv=setInterval(function(){fixLogos();if(++n>12)clearInterval(iv);},400);document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a'):null;if(!a)return;var href=a.getAttribute('href')||a.href;if(!href)return;try{var u=new URL(href,location.href);if(u.hostname==='school-of-gains.com'||u.hostname==='www.school-of-gains.com'){e.preventDefault();location.href=u.pathname+u.search+u.hash;}}catch(_){}}, true);})();</script>\n`;

// Injected only into the thank-you page. When Whop returns the user here after
// "Join" (?via=join&status=success), report the completed sign-up to GHL.
const JOINED_BEACON = `\n<script>(function(){try{var q=new URLSearchParams(location.search);if(q.get('via')!=='join')return;var e=sessionStorage.getItem('sog_join_email');if(!e)return;fetch('/api/joined',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,status:q.get('status')||'',attribution:(window.SOGAttribution?SOGAttribution.get():{})}),keepalive:true});sessionStorage.removeItem('sog_join_email');}catch(_){}})();</script>\n`;

function rewrite(html, pagePath) {
  let out = html
    .replaceAll('https://www.school-of-gains.com', '')
    .replaceAll('https://school-of-gains.com', '')
    .replaceAll('href=""', 'href="/"');
  for (const old of OLD_LOGOS) out = out.replaceAll(old, NEW_LOGO);
  const inject = INJECT + (pagePath === '/discord-free-lessons-thank-you' ? JOINED_BEACON : '');
  return out.includes('</body>')
    ? out.replace('</body>', inject + '</body>')
    : out + inject;
}

await mkdir('public', { recursive: true });

// Ship the new logo and expose it at /logo.png.
await copyFile('assets/logo.png', 'public/logo.png');
console.log('copied logo -> public/logo.png');

for (const [p, raw] of pages) {
  const rel = p.replace(/^\//, '');
  const file = path.join('public', rel + '.html');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rewrite(raw, p));
  console.log('wrote', file);
}

// Native onboarding flow (/join → /join/discord → /join/connect → thank-you).
// Static pages authored in src/join, served next to the mirrored GHL pages.
await cp('src/join', 'public/join', { recursive: true });
console.log('copied src/join -> public/join');

// Serve the home page at the site root too.
const home = pages.get('/home-page');
if (home) await writeFile('public/index.html', rewrite(home, '/home-page'));

console.log('Mirrored pages:', pages.size);
