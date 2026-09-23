# School of Gains — website and attribution

Versioned legacy pages plus native acquisition pages and server-side attribution APIs, deployed on Vercel.

`node build.mjs` builds **offline** from the checked-in `src/legacy/` snapshot and its verified SHA-256 manifest. It never fetches the live apex during a normal deployment. The legacy homepage remains `/`; native `/links`, `/apprentice`, `/apply`, `/book` and `/dashboard` are copied over their routes. Both legacy root brand assets and `/assets/` URLs are served. Existing legacy CDN dependencies remain external.

See [frozen-source instructions](src/legacy/README.md) for deliberate refresh and rollback, [live change register](docs/migration/live-change-register.md) for external mutations, and [verification report](docs/migration/integrated-verification-report.md) for tested behavior and remaining launch gates. Server configuration names are listed in `.env.attribution.example`; credentials must remain in the runtime environment, never browser bundles or Git. The new intake and GHL synchronization stay disabled until configured and verified.

## Main website branding

`assets/main-site.css` supplies shared typography, colors, buttons and responsive adjustments to the generated main website and Discord signup pages. `assets/brand.js` keeps header/footer artwork consistent after legacy hydration; `assets/brand.css` controls logo sizing. Edit these shared files instead of frozen page snapshots.

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
- `GHL_WEBHOOK_URL` — GoHighLevel Inbound Webhook URL (Automations → Workflow → trigger
  "Inbound Webhook"). Receives two events per lead as JSON:
  - `stage: "email_captured"` from `/api/subscribe` (step 1)
  - `stage: "whop_joined"` from `/api/joined`, fired by the thank-you page when Whop returns
    the user with `?via=join&status=success` (step 5)

  Payload: `email, stage, source, funnel, tags[], timestamp, ip, user_agent, referer` plus
  `form_source` / `whop_status`, and the first-touch attribution when present:
  `utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbclid, gclid, ttclid,
  landing_page, referrer, captured_at`. Map `email` to the contact, `stage`/`tags` to tags and
  the `utm_*` keys to custom fields in the workflow.

### UTM / attribution capture

`src/join/attribution.js` is injected into every page (mirrored GHL pages and `/join`). On the
first visit that carries `utm_*` / `fbclid` / `gclid` / `ttclid` it stores them in
`localStorage` (`sog_attribution`, 30 days, first touch wins) together with the landing page and
referrer. The `/join` flow sends that object with both events, and `/api/subscribe` forwards
the UTMs to Beehiiv as well (`utm_source/medium/campaign` + `referring_site`).

Every destination is optional and independent: a missing variable logs a warning and answers
`not_configured`, and the user-facing flow always continues.
