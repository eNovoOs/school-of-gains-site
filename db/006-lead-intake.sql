-- Additive prospect capture; no production execution or old-pipeline migration implied.
BEGIN;
CREATE TABLE IF NOT EXISTS sog_lead_cycles (
 id uuid PRIMARY KEY,
 contact_id uuid UNIQUE NOT NULL REFERENCES sog_contacts(id),
 entry_offer text NOT NULL CHECK(entry_offer IN ('community','newsletter','free_lessons','free_tools','webinar')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','superseded','review')),
 ghl_opportunity_id text UNIQUE,
 stage text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sog_lead_captures (
 id uuid PRIMARY KEY REFERENCES sog_events(event_id),
 contact_id uuid NOT NULL REFERENCES sog_contacts(id),
 journey_id uuid NOT NULL REFERENCES sog_journeys(id),
 lead_cycle_id uuid NOT NULL REFERENCES sog_lead_cycles(id),
 offer text NOT NULL CHECK(offer IN ('community','newsletter','free_lessons','free_tools','webinar')),
 profile jsonb NOT NULL,
 consent jsonb NOT NULL,
 attribution jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sog_lead_captures_contact ON sog_lead_captures(contact_id,created_at DESC);
-- Deliberately no FK: independently committed while the outbox locks lead-cycle rows.
-- Never clear automatically: an uncertain remote POST must not be repeated.
CREATE TABLE IF NOT EXISTS sog_lead_creation_attempts (
 cycle_id uuid PRIMARY KEY,
 ghl_contact_id text NOT NULL,
 attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sog_lead_capture_signals (
 id uuid PRIMARY KEY,
 ghl_contact_id text NOT NULL,
 capture_key text NOT NULL,
 offer text NOT NULL CHECK(offer IN ('community','newsletter','free_lessons','free_tools','webinar')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed')),
 attempts integer NOT NULL DEFAULT 0,
 last_error text,
 normalized_event_id uuid,
 received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 claim_token uuid
);
CREATE INDEX IF NOT EXISTS sog_lead_capture_signals_pending ON sog_lead_capture_signals(status,available_at);
COMMIT;
