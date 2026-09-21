import { mkdir, writeFile, copyFile, cp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Old School of Gains logo assets to swap for the new PaperGains logo.
const OLD_LOGOS = [
  'https://assets.cdn.filesafe.space/3mi3YQaZvtUMZzaQUuL6/media/69c3581dab2203884982a7c7.svg',
  'https://assets.cdn.filesafe.space/3mi3YQaZvtUMZzaQUuL6/media/69655d38f8a93b75c306981f.png'
];
const NEW_LOGO = '/logo.png';

// Build from versioned frozen legacy HTML plus native pages. The crawler below
// runs only with an explicit manual refresh flag and origin. External legacy
// assets and embeds remain intact; normal deployment builds make no requests.

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

// Injected into every page. GoHighLevel's runtime JS rewrites anchor hrefs back
// to absolute school-of-gains.com URLs, so we intercept clicks in the capture
// phase and keep same-apex navigation on this mirror. Subdomains and external
// links pass through untouched.
const INJECT = `\n<link rel="stylesheet" href="/brand.css">\n<script src="/brand.js"></script>\n<script src="/join/attribution.js"></script>\n<script>(function(){var LOGO='/logo.png';var IDS=['69c3581dab2203884982a7c7','69655d38f8a93b75c306981f'];function fixLogos(){var im=document.getElementsByTagName('img');for(var i=0;i<im.length;i++){var s=im[i].getAttribute('src')||'';for(var j=0;j<IDS.length;j++){if(s.indexOf(IDS[j])>-1){im[i].src=LOGO;break;}}}}fixLogos();document.addEventListener('DOMContentLoaded',fixLogos);var n=0,iv=setInterval(function(){fixLogos();if(++n>12)clearInterval(iv);},400);document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a'):null;if(!a)return;var href=a.getAttribute('href')||a.href;if(!href)return;try{var u=new URL(href,location.href);if(u.hostname==='school-of-gains.com'||u.hostname==='www.school-of-gains.com'){e.preventDefault();location.href=u.pathname+u.search+u.hash;}}catch(_){}}, true);})();</script>\n`;

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

// Legacy HTML is frozen in version control. Builds never crawl the live apex.
// An intentional refresh requires BOTH flags and an explicitly chosen old host.
const refresh = process.argv.includes('--refresh-legacy');
const refreshOriginArg = process.argv.find(value => value.startsWith('--legacy-origin='));
const checksum = value => createHash('sha256').update(value).digest('hex');
if (refresh) {
  if (!refreshOriginArg) throw new Error('Refresh requires --legacy-origin=https://THE-LEGACY-HOST. Never refresh from the replacement deployment.');
  const source = new URL(refreshOriginArg.slice('--legacy-origin='.length));
  if (source.protocol !== 'https:' || source.pathname !== '/' || source.search || source.hash) throw new Error('Legacy origin must be an HTTPS origin without a path/query.');
  const queue = [...SEEDS]; const visited = new Set(); const refreshed = new Map();
  while (queue.length && visited.size < 80) {
    const pagePath = queue.shift(); if (visited.has(pagePath)) continue; visited.add(pagePath);
    const response = await fetch(source.origin + pagePath, {headers:{'User-Agent':UA,Accept:'text/html'},signal:AbortSignal.timeout(20000)});
    if (!response.ok) { console.log('Legacy refresh skipped',pagePath,response.status); continue; }
    const html = await response.text();
    refreshed.set(pagePath.replace(/^\//,'')+'.html',rewrite(html,pagePath));
    for (const match of html.matchAll(/href="([^"]+)"/g)) { const candidate=normalizePath(match[1]); if(candidate && !visited.has(candidate) && !queue.includes(candidate)) queue.push(candidate); }
  }
  if (!refreshed.has('home-page.html')) throw new Error('Refresh did not return the legacy home page; existing snapshot kept.');
  refreshed.set('index.html',refreshed.get('home-page.html'));
  const manifest={version:1,capturedAt:new Date().toISOString(),source:'Explicit manual legacy refresh',sourceOrigin:source.origin,alreadyRewritten:true,containsExistingLegacyScripts:true,pages:[]};
  await mkdir('src/legacy',{recursive:true});
  for(const [file,html] of refreshed) { await writeFile(path.join('src/legacy',file),html);manifest.pages.push({file,route:file==='index.html'?'/':'/'+file.slice(0,-5),sha256:checksum(html),bytes:Buffer.byteLength(html)}); }
  await writeFile('src/legacy/manifest.json',JSON.stringify(manifest,null,2)+'\n');
  console.log('Legacy snapshot intentionally refreshed. Review the source diff before deployment.');
}
const manifest=JSON.parse(await readFile('src/legacy/manifest.json','utf8'));
if(manifest.version!==1 || !manifest.pages?.some(page=>page.file==='index.html')) throw new Error('Missing or invalid frozen legacy manifest');
const frozen=[];
for(const page of manifest.pages) {
  if(!/^[a-zA-Z0-9_-]+\.html$/.test(page.file)) throw new Error('Unsafe legacy snapshot path');
  const html=await readFile(path.join('src/legacy',page.file));
  if(checksum(html)!==page.sha256) throw new Error('Legacy snapshot checksum mismatch: '+page.file);
  frozen.push([page.file,html]);
}
// Intentional output-only tracking migration. Frozen source bytes stay available
// for rollback. Keep body-end execution order so the existing joined beacon sees
// the new helper; head-loaded join pages defer until the body exists.
function globalAttribution(html) {
  const old='<script src="/join/attribution.js"></script>';
  const oldAt=html.indexOf(old);
  if(oldAt<0) throw new Error('Expected legacy attribution include missing');
  const inHead=html.indexOf('</head>')>oldAt;
  return html.replace(old,'<link rel="stylesheet" href="/acquisition/consent.css">\n<script src="/acquisition/attribution.js"'+(inHead?' defer':'')+'></script>');
}
// All frozen sources are verified before replacing generated output.
await rm('public',{recursive:true,force:true});
await mkdir('public',{recursive:true});
for(const [file,html] of frozen) await writeFile(path.join('public',file),globalAttribution(html.toString()));
// Preserve root asset paths for old mirrored HTML and /assets paths for new pages.
await cp('assets','public/assets',{recursive:true});
for(const file of ['logo.png','brand.css','brand.js']) await copyFile(path.join('assets',file),path.join('public',file));
await cp('src/join','public/join',{recursive:true});
for(const file of await readdir('src/join')) if(file.endsWith('.html')) { const html=await readFile(path.join('src/join',file),'utf8');await writeFile(path.join('public/join',file),globalAttribution(html)); }
await mkdir('public/acquisition',{recursive:true});
for(const file of await readdir('src/acquisition')) if(/\.(js|css)$/.test(file)) await copyFile(path.join('src/acquisition',file),path.join('public/acquisition',file));
const nativePages=[];
for(const file of await readdir('src/acquisition/pages')) if(file.endsWith('.html')) { await copyFile(path.join('src/acquisition/pages',file),path.join('public',file));nativePages.push('/'+file.slice(0,-5)); }
await cp('src/dashboard','public/dashboard',{recursive:true});
console.log('Offline build complete:',frozen.length,'frozen legacy pages; native routes:',nativePages.join(', '),'/dashboard');
