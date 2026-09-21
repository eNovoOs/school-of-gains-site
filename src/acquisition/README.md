# Shared acquisition pages

Native static pages for `/links`, `/apprentice`, `/apply`, and `/book`. Copy `pages/*.html` to matching public routes, and the sibling CSS/JS files to `/acquisition/`. They use the existing `/assets/brand.css` and `/assets/logo.png` hat/wordmark.

`questions.js` is the versioned public quiz contract. It preserves the subjects of the audited legacy quizzes, with neutral attendance wording, standard contact fields, no score tiers, and no automatic booking exclusion. Required questions are grouped into five accessible steps. Contact information and answers remain in the form until submitted; the browser stores only anonymous IDs and sanitized acquisition metadata when analytics consent is granted. Marketing email consent is optional and separate from application handling.

`attribution.js` exposes `window.SOGAttribution.get()` as `{journeyId, firstTouch, latestTouch}`. If capture is unavailable the application supplies an anonymous journey UUID and empty attribution, without inventing a source. Analytics failures do not block the form.

Submit contract:

```
POST /api/applications
{
  submissionId, journeyId, quizVersion: "apprentice-v1",
  contact: { firstName, lastName, email, phone },
  answers: { ageRange, goals: [], weeklyTime, educationBudget, attendance, notes },
  consent: { privacy: true, marketing: false },
  attribution: { firstTouch, latestTouch },
  website: ""
}
```

The server validates the schema and deduplicates on submission ID. It must return `{ok:true, applicationId, bookingPath:"/book?ref=<opaque-token>"}` only after durable acceptance. The page refuses to navigate to an external URL or an uncorrelated generic booking page. A retry uses the same submission ID; the API must return the original application and booking token for a replay. `/api/events` receives one `quiz_started` event upon the first form interaction. The shared capture helper owns page views.

`/book` integration and confirmed appointment reconciliation are separate responsibilities; application completion is never represented as a booking. These pages do not load a live legacy quiz or submit to a legacy workflow.

Validation performed: JavaScript syntax; static HTML parsing and unique IDs. No live application submitted. Browser/mobile and end-to-end validation remain required after build integration.

## Analytics consent and session policy

The capture helper defaults to `pending`: current-page acquisition context stays in memory and no analytics request is sent. `SOGAttribution.setConsent('granted')` enables anonymous attribution persistence in localStorage for 30 days and page/quiz events. `setConsent('denied')` removes the stored journey and stops analytics. A minimal consent preference is remembered, independently of contact/marketing consent. DNT or Global Privacy Control force analytics off. The helper inserts a compact equal-choice analytics panel and a footer preferences control on these pages. Until a choice is made it safely remains pending. The application can submit its current-page context with the applicant's application-handling consent, even when analytics is denied; cross-page attribution will be incomplete in that case.

The first actual touch is immutable within the 30-day journey. Latest non-direct touch changes only for external referrals or valid incoming campaign/click codes; direct returns and internally tagged links never replace it. Sessions expire after 30 minutes of inactivity. The contact-level server record independently preserves its original first touch beyond the browser window. Referrers are stored as origins only; landing pages retain safe route paths only. Query strings, fragments, arbitrary query parameters, and email-like tracking values are discarded. Campaign names must use registered codes (letters, numbers, underscores, dots, hyphens, tildes), never personal information.

Validation: `node --test tests/attribution-client.test.js` covers repeat/internal/direct visits, campaign changes, consent pending/revocation, query identity removal, expiry, privacy signals, blocked storage, and immutable snapshots (7 passing cases).

## Booking launch blocker

`book.js` checks the signed opaque reference with `GET /api/booking-context?ref=…`, using no-referrer and no-store protections. The native bridge remains disabled until runtime configuration and live verification are complete. When enabled, the page retrieves available times from `/api/booking-slots`, displays them in the chosen timezone, and submits an opaque reference plus a stable booking ID to `/api/bookings`. Confirmation appears only for provider-verified success. Uncertain requests keep their booking ID and lock slot changes; stale slots refresh availability; reload resumes existing requests supplied by booking context. The page never embeds an uncorrelated legacy calendar or puts applicant identity into calendar URLs. Public launch remains gated until runtime configuration, a controlled real booking, reminders, and appointment webhook reconciliation are verified.

## Legacy site compatibility

The build loads the same helper and scoped `consent.css` on preserved website/join pages. Do not inject `site.css` into those pages: its broader styles belong to the new native pages. `get()` includes backward-compatible flat first-touch aliases in addition to the canonical nested fields. The previous `src/join/attribution.js` is now a zero-storage non-overwriting compatibility shim, with its prior version verified in the private pre-migration archive and separately backed up before editing. The new helper deletes rather than imports the old unconsented `sog_attribution` cache.

Final client checks: 8 attribution cases and 7 booking cases. No live submissions or bookings were created by these tests.
