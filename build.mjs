import { mkdir, writeFile } from 'node:fs/promises';

// Snapshot the live School of Gains home page into a static file at build time.
const TARGET = 'https://school-of-gains.com/home-page';

const res = await fetch(TARGET, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }
});

if (!res.ok) {
  throw new Error('Fetch failed: ' + res.status + ' ' + res.statusText);
}

const html = await res.text();
await mkdir('public', { recursive: true });
await writeFile('public/index.html', html);
console.log('Wrote public/index.html:', html.length, 'bytes');
