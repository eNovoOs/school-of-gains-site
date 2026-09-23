-- Durable POST fence outside outbox transactions. Intentionally no cycle FK:
-- the delivery transaction may hold its row lock when this reservation commits.
BEGIN;
CREATE TABLE IF NOT EXISTS sog_opportunity_creation_attempts (
 cycle_id uuid PRIMARY KEY,
 ghl_contact_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
