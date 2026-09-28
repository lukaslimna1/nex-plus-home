import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- 1. JOB HEADS (Projeção Operacional Mutável)
    -- Criada antes de nex_job_events para que eventos históricos possuam FK restrict
    CREATE TABLE IF NOT EXISTS "nex_job_heads" (
      "job_id" varchar PRIMARY KEY NOT NULL,
      "status" varchar NOT NULL CHECK ("status" IN ('queued', 'running', 'waiting', 'paused', 'succeeded', 'failed', 'cancelled')),
      "revision" integer NOT NULL CHECK ("revision" >= 1),
      "created_at" timestamp(3) with time zone NOT NULL,
      "updated_at" timestamp(3) with time zone NOT NULL,
      "started_at" timestamp(3) with time zone,
      "finished_at" timestamp(3) with time zone,
      "state_payload" jsonb NOT NULL,
      CONSTRAINT "nex_job_heads_lifecycle_timestamps_chk" CHECK (
        ("status" IN ('queued', 'paused') AND "finished_at" IS NULL) OR
        ("status" IN ('running', 'waiting') AND "started_at" IS NOT NULL AND "finished_at" IS NULL) OR
        ("status" = 'succeeded' AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL) OR
        ("status" IN ('failed', 'cancelled') AND "finished_at" IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_job_heads_status_idx" ON "nex_job_heads" USING btree ("status");
    CREATE INDEX IF NOT EXISTS "nex_job_heads_updated_at_idx" ON "nex_job_heads" USING btree ("updated_at");

    -- 2. JOB EVENTS (Histórico Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_job_events" (
      "job_id" varchar NOT NULL REFERENCES "nex_job_heads"("job_id") ON DELETE RESTRICT,
      "revision" integer NOT NULL CHECK ("revision" >= 1),
      "record_kind" varchar NOT NULL CHECK ("record_kind" IN ('created', 'transition')),
      "event_type" varchar CHECK ("event_type" IN (
        'JobStarted',
        'JobAttemptCorrelated',
        'JobWaiting',
        'JobYieldedWaiting',
        'JobControlRequested',
        'JobPaused',
        'JobResumed',
        'JobProgressUpdated',
        'JobSucceeded',
        'JobFailed',
        'JobCancelled'
      )),
      "occurred_at" timestamp(3) with time zone NOT NULL,
      "payload" jsonb NOT NULL,
      "append_sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      PRIMARY KEY ("job_id", "revision"),
      CONSTRAINT "nex_job_events_kind_chk" CHECK (
        ("record_kind" = 'created' AND "revision" = 1 AND "event_type" IS NULL) OR
        ("record_kind" = 'transition' AND "revision" >= 2 AND "event_type" IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_job_events_job_id_idx" ON "nex_job_events" USING btree ("job_id");
    CREATE INDEX IF NOT EXISTS "nex_job_events_occurred_at_idx" ON "nex_job_events" USING btree ("occurred_at");
    CREATE INDEX IF NOT EXISTS "nex_job_events_append_seq_idx" ON "nex_job_events" USING btree ("append_sequence");

    CREATE TRIGGER "nex_job_events_mut_trg" BEFORE UPDATE OR DELETE ON "nex_job_events" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_job_events_trunc_trg" BEFORE TRUNCATE ON "nex_job_events" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "nex_job_events";
    DROP TABLE IF EXISTS "nex_job_heads";
  `);
}
