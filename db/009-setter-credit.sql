-- An administrator attests who booked; this is not individual staff login proof.
BEGIN;
CREATE TABLE IF NOT EXISTS sog_booking_setter_credits (
 appointment_id text PRIMARY KEY REFERENCES sog_appointments(id),
 setter_id text NOT NULL,
 evidence_type text NOT NULL CHECK(evidence_type='admin_attested'),
 request_id uuid UNIQUE NOT NULL,
 reason text NOT NULL,
 admin_session_hash text NOT NULL,
 provider_revision timestamptz NOT NULL,
 attested_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
