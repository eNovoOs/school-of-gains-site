# School of Gains — Home Page (static mirror)

A static mirror of [school-of-gains.com/home-page](https://school-of-gains.com/home-page).

The build step (`build.mjs`) fetches the live home page at deploy time and writes it to
`public/index.html`, which Vercel serves as a static site. All images, CSS, JS and fonts
load from their original CDNs, so the mirror renders identically to the source.

## Deploy settings

- Build command: `node build.mjs`
- Output directory: `public`
- Framework preset: Other (none)
