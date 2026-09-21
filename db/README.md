# Attribution runtime and launch gates

This schema and code are a preview foundation, not an activated production migration. No database migration or provider calls were executed by the backend agent. Runtime intake and GHL sync default to disabled.

## Dependencies and install

Root package includes `pg`. The database needs PostgreSQL with a pooled TLS connection (`DATABASE_URL` supplied server-side by the approved provider). Apply `001-attribution.sql` then `002-booking.sql` and `003-closer-rotation.sql` only after backup, the correct Vercel project/environment link and disposable-database validation. It is additive and uses only the `sog_` namespace. Do not drop these tables on rollback: disable intake/sync and retain submissions, immutable events and undelivered outbox jobs. Restore app deployment and CRM configuration from the migration ledger.

## HTTP contracts

- `POST /api/events`: `eventId`, `journeyId` (UUIDs), `type` (`page_view` or `quiz_started`), `path` without query string, `attribution` with `firstTouch`/`latestTouch`.
- `POST /api/applications`: `submissionId`, `journeyId` (UUIDs), `quizVersion: apprentice-v1`, `contact: { email,firstName,lastName,phone }`, `answers`, `consent: { privacy:true,marketing:boolean }`, attribution. Exact answer options are validated against the agreed quiz v1. Honeypot `website` must be blank. Duplicate ID for the same identity returns the original ID without another event or outbox entry. Responds only after commit. `crmSync: queued` explicitly does not mean GHL delivered.
- `GET /api/booking-context?ref=...`: signed, one-hour bearer handoff token from application response; returns only application ID, GHL identity-link status, and `bookingEnabled` only when the native booking flag, provider runtime and delivered CRM sync are ready. No email in response. Also includes a minimal `existingBooking` summary so reloads resume the same pending request instead of creating a duplicate.
- `POST /api/webhooks/ghl`: `Authorization: Bearer $GHL_EVENTS_SECRET`, exact School of Gains location. This is a **normalized Custom Webhook adapter**, not an unmodified Marketplace webhook endpoint. Appointment payload requires UUID `eventId`, `locationId`, `appointmentId`, `contactId`, `calendarId`, `status` (new/confirmed/cancelled/showed/noshow/invalid), ISO `startsAt`/`updatedAt`, optional verified `bookingSetterId`. The calendar must be allowlisted. Booking setter cannot be set by public UTMs or form payloads.
- Same webhook with `type: opportunity_updated`: UUID `eventId`, `locationId`, `pipelineId` (retained closers only), `opportunityId`, `pipelineStageId`, `status` (open/won/lost), ISO `updatedAt`. Required to keep local sales cycles aligned with actual won/lost CRM state.
- `GET` or `POST /api/webhooks/process`: server bearer `CRON_SECRET`, processes at most one durable outbox job with row locking. Configure a protected schedule/worker after live validation; no cron has been enabled. Retries exponential backoff up to ten attempts, then a failed queue for review. A scheduler invocation alone does not retry failed records indefinitely.

## GHL mappings

Location is fixed to `3mi3YQaZvtUMZzaQUuL6`; only `GxJOcIsgv7Svx90E2BZr` is used for new Apprentice opportunities. Existing setter pipeline is not changed by these endpoints. `GHL_UNBOOKED_STAGE_ID=6b696d4a-3373-4f95-b880-a6cd524f727a` was verified in the retained closer pipeline. `GHL_CLOSER_IDS` is an ordered comma-separated pool of verified active closers. New unbooked opportunities rotate evenly through this pool; existing opportunity owners remain unchanged. The ten provisioned field IDs are in `docs/migration/ghl-field-map.json` and the non-secret example environment. New application starts unbooked; active remote opportunity retains owner and stage. Multiple active matches require review. Prior won contacts require review rather than another acquisition opportunity.

`GHL_STAGE_IDS_JSON` must map local `unbooked`, `booked`, `call_held`, `no_show`, `follow_up` plus any operational mapping needed to actual main closer stage IDs. An unknown legacy remote stage blocks automatic stage updates. Closed or progressed opportunities cannot regress on a booking event.

`GHL_ATTRIBUTION_FIELDS_JSON` contains IDs of ten newly provisioned **text** contact fields: `application_id`, `cycle_id`, `quiz_version`, `answers`, `first_source`, `first_medium`, `first_campaign`, `latest_source`, `latest_medium`, `latest_campaign`. `answers` should be a large text field. The sync sends `customFields[].fieldValue`, never overwrites tags, DND or consent. Marketing consent is durably recorded but does not enroll a marketing sequence automatically. A late retry for an older application cannot replace latest application fields.

The first source is immutable in our contact record; last non-direct updates by captured timestamp. Each application/appointment keeps its own snapshot. URLs have query strings and fragments removed; raw UTMs and click IDs remain server-side. Native API bookings retain the correlated application snapshot. Other booking webhook snapshots reflect latest known contact attribution at ingestion; this is distinct from a freshly captured booking-browser touch.

## Remaining release gates

1. Provision correct environment/database, validate SQL constraints and concurrency on a disposable database, then supply secrets and mappings. Unit tests use mocked DB/provider interactions and do not establish real SQL/provider correctness.
2. Run the native booking adapter against a controlled test contact/calendar with calendars.readonly, calendars/events.readonly, calendars/events.write and contacts.readonly scopes. Verify returned event fields, round-robin assignment, notice/buffer rules, selected timezone, meeting link generation, cancellation and reminder behavior before enabling GHL_BOOKING_ENABLED. Do not strand visitors on an unavailable calendar.
3. Create GHL normalized appointment and opportunity event senders covering self-service, staff booking, updates, cancellation, attendance and close outcomes. Verify actual timestamps, UUID event IDs, retry semantics and setter identity. Header authentication is required; native webhook signature formats are not inferred.
4. Import/reconcile existing CRM identity and sales-cycle links before broad booking webhook activation. Unknown contact/opportunity currently returns retryable 409 rather than guessing email identity. The current adapter does not backfill historical customers or ingest payments/refunds.
5. Reconcile appointments missed during outages; create an operator retry/replay runbook for failed outbox jobs. Do not mark dashboard as complete until reconciliation works.
6. Test contact duplicate settings and opportunity lookup pagination. Adapter pins documented 2021-07-28 endpoints; deprecated GET opportunity search must be verified or replaced before production.
7. Add approved CRM notification/task/reminder flows keyed to new application fields; current code does not send messages. Existing live workflows must be scoped/paused only at safe cutover to avoid duplicate routing and reminders.
8. Configure rate-limit retention cleanup and privacy retention/deletion process. No contact or secret is logged by these new modules.

## Verification

`node --test tests/backend*.test.js` checks validation, forbidden public conversion events, attribution precedence, duplicate submission no-write, identity collision rollback, stale appointment guard, GHL reuse and terminal-stage protection. It is deliberately not described as an end-to-end booking test.

Official API references used: [contact update](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/contacts/update-contact/index.html), [contact upsert](https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/), [opportunity search](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/search-opportunity/index.html).

## Native booking bridge

`GET /api/booking-slots?ref=<signed-token>&startDate=<epoch-ms>&endDate=<epoch-ms>&timezone=<IANA-zone>` returns `{ok:true,slots:[ISO,...],timezone}`. It reads GHL calendar free slots; requests longer than 31 days or outside the supported horizon are rejected. Client cannot choose another calendar, contact, owner or setter.

`POST /api/bookings` accepts `{ref,bookingId:<UUID>,startTime:<offset-ISO>,timezone}`. The server resolves the saved application and synced GHL contact, reserves a durable booking intent, checks current free slots and creates via `/calendars/events/appointments` with date-range/free-slot bypass flags **false**. `toNotify` is controlled by explicit `GHL_BOOKING_NOTIFICATIONS_ENABLED` and defaults false during testing; enable only after sales reminder cutover to prevent duplicates. This is an actual booking API; enabling it is a production activation step.

A successful create response is not enough: the adapter GETs the event and verifies exact contact, location, calendar, start, accepted status and provider updated timestamp before returning `{ok:true,booked:true,appointmentId,startTime,timezone}` and recording the appointment. The confirmed provider response establishes the initial event; normalized provider webhooks handle subsequent changes. Webhook contract tests remain mandatory.

Ambiguous timeouts or 5xx return HTTP202 `{ok:true,booked:false,pending:true,reason:'booking_verification_pending'}`. Retry **the same bookingId and same slot**; it reads/reconciles rather than issuing another POST. Reconciliation requires the booking-reference marker, so a legacy same-slot appointment is not wrongly credited to this application. Without conclusive evidence, the request remains pending for sales review. Conflicts return 409; only `slot_unavailable`/`choose_another_slot` allow a fresh selection automatically. `appointment_already_exists` and `booking_already_in_progress` require examining the existing booking.

Only one active intent is allowed per sales cycle, including across applications and browser reloads. Negative lifecycle events release a cancelled/invalid intent after recording the provider event. A confirmed intent and its history are retained, never deleted to permit retries. The native endpoints never derive booking setter credit from UTMs; verified staff workflows supply it separately.

Documentation: [free slots](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/calendars/get-slots/index.html), [create appointment](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/calendars/create-appointment/index.html), [get appointment](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/calendars/get-appointment/index.html), [contact appointments scope](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/index.html).

## Closer distribution

`GHL_CLOSER_IDS=BCR448vrYnQHOwub4MEd,Rt4YE2nRGqKHwKkq2jVo` is the currently verified two-closer pool. This controls new **unbooked** applications only. It does not change the calendar's OptimizeForAvailability scheduling rule, reassign existing open opportunities, or grant booking setter credit.

After checking GHL for an existing open opportunity, a genuinely new opportunity receives the next round-robin reservation. A PostgreSQL advisory transaction lock serializes allocation across workers. The selected closer and pool version/members commit into `sog_closer_assignments` **before** the provider create request. A duplicate request, timeout, outbox rollback or retry reuses the cycle's reservation and does not consume another turn. Existing open opportunities skip the allocator entirely.

The allocator uses its own small connection pool so committing an allocation cannot wait for a connection held by the parent outbox transaction. Its cycle key intentionally has no foreign key to the locked sales-cycle table; only trusted server-resolved cycle UUIDs are accepted. Keep assignment/counter records on rollback. If a selected closer leaves the team while a reservation is pending, review/reassign that reservation explicitly rather than deleting it or silently shifting the lead on retry. Updated pools affect only new reservations. With an unchanged pool, allocation counts differ by at most one; uneven existing workload is not automatically rebalanced.
