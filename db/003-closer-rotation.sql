-- Durable round robin for newly created Apprentice opportunities only.
BEGIN;
CREATE TABLE IF NOT EXISTS sog_closer_rotation (
 pool_key text PRIMARY KEY,
 next_position bigint NOT NULL DEFAULT 0 CHECK(next_position>=0)
);
CREATE TABLE IF NOT EXISTS sog_closer_assignments (
 -- No FK intentionally: allocation commits independently while the outbox
 -- transaction holds the sales cycle row lock. Only server cycle IDs enter here.
 cycle_id uuid PRIMARY KEY,
 closer_id text NOT NULL,
 pool_key text NOT NULL REFERENCES sog_closer_rotation(pool_key),
 pool_version text NOT NULL,
 pool_members text[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sog_sales_cycles ADD COLUMN IF NOT EXISTS assigned_closer_id text;
COMMIT;
