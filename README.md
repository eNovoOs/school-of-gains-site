# School of Gains — Home Page (static mirror)

A static mirror of [school-of-gains.com/home-page](https://school-of-gains.com/home-page).

The build step (`build.mjs`) fetches the live home page at deploy time and writes it to
`public/index.html`, which Vercel serves as a static site. All images, CSS, JS and fonts
load from their original CDNs, so the mirror renders identically to the source.

## Deploy settings

- Build command: `node build.mjs`
- Output directory: `public`
- Framework preset: Other (none)

## Native Discord onboarding flow (`/join`)

A 5-step flow, authored in `src/join/` and copied to `public/join/` at build time,
that replaces the "email → check your inbox" hand-off with an in-page Whop connection:

| Step | URL | What happens |
|---|---|---|
| 1 | `/join` | Email capture. Posts to `/api/subscribe` (Beehiiv), then continues. |
| 2 | `/join/discord` | "Do you already have a Discord account?" — Yes / No. |
| 3 | `/join/connect` | Whop embedded checkout for the free plan (`plan_PWxXNWaKYvnXc`), email prefilled. |
| 4A | `/join/create` | Guide to create a Discord account → `discord.com/register`. |
| 4B | `/join/ready` | Return page after creating the account → back to step 3. |
| 5 | `/discord-free-lessons-thank-you?status=success&via=join` | Whop's `return-url`. Existing SOG thank-you page. |

The email travels between steps via `?email=` + `sessionStorage`; steps 2–4 redirect to `/join` if it is missing.

### Environment variables (Vercel → Project → Settings → Environment Variables)

- `BEEHIIV_API_KEY` — Beehiiv API key.
- `BEEHIIV_PUBLICATION_ID` — the `pub_…` id of the School of Gains publication.

Without them `/api/subscribe` answers `{ ok: false, error: "not_configured" }` and the flow
still continues (the email is only captured by Whop at step 3).
