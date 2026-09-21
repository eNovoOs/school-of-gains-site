BEGIN;
CREATE TABLE IF NOT EXISTS sog_booking_intents (
 id uuid PRIMARY KEY,
 application_id uuid NOT NULL REFERENCES sog_applications(id),
 cycle_id uuid NOT NULL REFERENCES sog_sales_cycles(id),
 start_time timestamptz NOT NULL,
 timezone text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','uncertain','confirmed','conflict','failed','cancelled')),
 appointment_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sog_one_pending_booking ON sog_booking_intents(cycle_id) WHERE state IN ('pending','uncertain','confirmed');
COMMIT;
