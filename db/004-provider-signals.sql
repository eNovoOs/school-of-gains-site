-- Additive inbox for authenticated GHL workflow signals. Apply after 001-003.
BEGIN;
CREATE TABLE IF NOT EXISTS sog_provider_signals (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('appointment','opportunity')),
 resource_id text NOT NULL,
 contact_id text,
 workflow_key text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed')),
 attempts integer NOT NULL DEFAULT 0,
 normalized_event_id uuid,
 last_error text,
 received_at timestamptz NOT NULL DEFAULT now(),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 claim_token uuid,
 processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS sog_provider_signals_pending ON sog_provider_signals(status,available_at);
COMMIT;
