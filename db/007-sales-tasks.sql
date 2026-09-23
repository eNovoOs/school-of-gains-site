-- Managed tasks only. No historic GHL task is adopted by title or contact alone.
BEGIN;
CREATE TABLE IF NOT EXISTS sog_sales_tasks (
 id uuid PRIMARY KEY,
 cycle_id uuid NOT NULL REFERENCES sog_sales_cycles(id),
 episode integer NOT NULL CHECK(episode>0),
 ghl_contact_id text NOT NULL,
 ghl_opportunity_id text NOT NULL,
 due_at timestamptz NOT NULL,
 desired_state text NOT NULL DEFAULT 'open' CHECK(desired_state IN ('open','completed')),
 provider_task_id text UNIQUE,
 assigned_user_id text,
 completion_reason text,
 create_started_at timestamptz,
 provider_completed boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','synced','review')),
 attempts integer NOT NULL DEFAULT 0,
 last_error text,
 available_at timestamptz NOT NULL DEFAULT now(),
 claim_token uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(cycle_id,episode)
);
CREATE UNIQUE INDEX IF NOT EXISTS sog_sales_tasks_open_episode ON sog_sales_tasks(cycle_id) WHERE desired_state='open';
CREATE INDEX IF NOT EXISTS sog_sales_tasks_pending ON sog_sales_tasks(available_at) WHERE status<>'review';
COMMIT;
