import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- 1. ATTEMPT HEADS (Projeção Operacional Mutável)
    -- Criada antes de attempt_events para que eventos históricos possuam FK restrict
    CREATE TABLE IF NOT EXISTS "nex_execution_attempt_heads" (
      "attempt_id" varchar PRIMARY KEY NOT NULL,
      "append_sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      "decision_id" varchar NOT NULL,
      "route_evaluation_id" varchar NOT NULL,
      "capability_revision_id" varchar NOT NULL,
      "binding_revision_id" varchar NOT NULL,
      "route_revision_id" varchar NOT NULL,
      "policy_revision_id" varchar,
      "status" varchar NOT NULL CHECK ("status" IN ('created', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'unknown_completion')),
      "created_at" timestamp(3) with time zone NOT NULL,
      "started_at" timestamp(3) with time zone,
      "finished_at" timestamp(3) with time zone,
      "terminal_reason" text,
      "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
      CONSTRAINT "nex_att_heads_lifecycle_chk" CHECK (
        ("status" = 'created' AND "started_at" IS NULL AND "finished_at" IS NULL) OR
        ("status" = 'running' AND "started_at" IS NOT NULL AND "finished_at" IS NULL) OR
        ("status" IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'unknown_completion') AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL)
      ),
      CONSTRAINT "nex_att_heads_decision_lineage_uniq" UNIQUE ("attempt_id", "decision_id", "route_evaluation_id")
    );

    CREATE INDEX IF NOT EXISTS "nex_att_heads_decision_id_idx" ON "nex_execution_attempt_heads" USING btree ("decision_id");
    CREATE INDEX IF NOT EXISTS "nex_att_heads_status_idx" ON "nex_execution_attempt_heads" USING btree ("status");
    CREATE INDEX IF NOT EXISTS "nex_att_heads_append_seq_idx" ON "nex_execution_attempt_heads" USING btree ("append_sequence");

    -- 2. ATTEMPT EVENTS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_execution_attempt_events" (
      "attempt_id" varchar NOT NULL REFERENCES "nex_execution_attempt_heads"("attempt_id") ON DELETE RESTRICT,
      "sequence_number" integer NOT NULL CHECK ("sequence_number" >= 1),
      "event_type" varchar NOT NULL CHECK ("event_type" IN ('AttemptCreated', 'AttemptStarted', 'AttemptTerminal')),
      "event_payload" jsonb NOT NULL,
      "occurred_at" timestamp(3) with time zone NOT NULL,
      PRIMARY KEY ("attempt_id", "sequence_number")
    );

    CREATE INDEX IF NOT EXISTS "nex_att_events_att_id_idx" ON "nex_execution_attempt_events" USING btree ("attempt_id");
    CREATE INDEX IF NOT EXISTS "nex_att_events_occurred_at_idx" ON "nex_execution_attempt_events" USING btree ("occurred_at");

    CREATE TRIGGER "nex_att_events_mut_trg" BEFORE UPDATE OR DELETE ON "nex_execution_attempt_events" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_att_events_trunc_trg" BEFORE TRUNCATE ON "nex_execution_attempt_events" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    -- 3. EXECUTION SIGNALS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_execution_signals" (
      "signal_id" varchar PRIMARY KEY NOT NULL,
      "append_sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      "attempt_id" varchar NOT NULL REFERENCES "nex_execution_attempt_heads"("attempt_id") ON DELETE RESTRICT,
      "kind" varchar NOT NULL,
      "safe_metadata" jsonb NOT NULL,
      "provenance" jsonb NOT NULL,
      "observed_at" timestamp(3) with time zone NOT NULL,
      CONSTRAINT "nex_sig_attempt_uniq" UNIQUE ("signal_id", "attempt_id")
    );

    CREATE INDEX IF NOT EXISTS "nex_signals_attempt_id_idx" ON "nex_execution_signals" USING btree ("attempt_id");
    CREATE INDEX IF NOT EXISTS "nex_signals_observed_at_idx" ON "nex_execution_signals" USING btree ("observed_at");
    CREATE INDEX IF NOT EXISTS "nex_signals_append_seq_idx" ON "nex_execution_signals" USING btree ("append_sequence");

    CREATE TRIGGER "nex_signals_mut_trg" BEFORE UPDATE OR DELETE ON "nex_execution_signals" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_signals_trunc_trg" BEFORE TRUNCATE ON "nex_execution_signals" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    -- 4. EXECUTION EVIDENCE (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_execution_evidence" (
      "evidence_id" varchar PRIMARY KEY NOT NULL,
      "append_sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      "attempt_id" varchar NOT NULL REFERENCES "nex_execution_attempt_heads"("attempt_id") ON DELETE RESTRICT,
      "kind" varchar NOT NULL CHECK ("kind" IN ('dispatch_confirmed', 'pre_dispatch_failure', 'effect_observed', 'no_effect_verified', 'result_verified', 'technical_unproven')),
      "safe_facts" jsonb NOT NULL,
      "provenance" jsonb NOT NULL,
      "recorded_at" timestamp(3) with time zone NOT NULL,
      "no_side_effect_guarantee" varchar CHECK ("no_side_effect_guarantee" IS NULL OR "no_side_effect_guarantee" IN ('structural', 'none')),
      CONSTRAINT "nex_evidence_attempt_uniq" UNIQUE ("evidence_id", "attempt_id")
    );

    CREATE INDEX IF NOT EXISTS "nex_evidence_attempt_id_idx" ON "nex_execution_evidence" USING btree ("attempt_id");
    CREATE INDEX IF NOT EXISTS "nex_evidence_recorded_at_idx" ON "nex_execution_evidence" USING btree ("recorded_at");
    CREATE INDEX IF NOT EXISTS "nex_evidence_append_seq_idx" ON "nex_execution_evidence" USING btree ("append_sequence");

    CREATE TRIGGER "nex_evidence_mut_trg" BEFORE UPDATE OR DELETE ON "nex_execution_evidence" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_evidence_trunc_trg" BEFORE TRUNCATE ON "nex_execution_evidence" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    -- 5. EVIDENCE <-> SIGNALS (Relacional Append-Only, sem UNIQUE de signal para permitir repetição legítima de refs)
    CREATE TABLE IF NOT EXISTS "nex_execution_evidence_signals" (
      "evidence_id" varchar NOT NULL,
      "signal_id" varchar NOT NULL,
      "attempt_id" varchar NOT NULL,
      "position" integer NOT NULL CHECK ("position" >= 0),
      PRIMARY KEY ("evidence_id", "position"),
      FOREIGN KEY ("evidence_id", "attempt_id") REFERENCES "nex_execution_evidence"("evidence_id", "attempt_id") ON DELETE RESTRICT,
      FOREIGN KEY ("signal_id", "attempt_id") REFERENCES "nex_execution_signals"("signal_id", "attempt_id") ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS "nex_evi_sig_signal_idx" ON "nex_execution_evidence_signals" USING btree ("signal_id");

    CREATE TRIGGER "nex_evi_sig_mut_trg" BEFORE UPDATE OR DELETE ON "nex_execution_evidence_signals" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_evi_sig_trunc_trg" BEFORE TRUNCATE ON "nex_execution_evidence_signals" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    -- 6. OUTCOME ASSESSMENTS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_execution_outcome_assessments" (
      "assessment_id" varchar PRIMARY KEY NOT NULL,
      "append_sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      "attempt_id" varchar NOT NULL REFERENCES "nex_execution_attempt_heads"("attempt_id") ON DELETE RESTRICT,
      "verdict" varchar NOT NULL CHECK ("verdict" IN ('confirmed_mutation', 'confirmed_no_mutation', 'confirmed_result', 'indeterminate')),
      "reason_code" varchar NOT NULL,
      "supersedes_assessment_id" varchar,
      "assessed_at" timestamp(3) with time zone NOT NULL,
      CONSTRAINT "nex_outcome_attempt_uniq" UNIQUE ("assessment_id", "attempt_id"),
      FOREIGN KEY ("supersedes_assessment_id", "attempt_id") REFERENCES "nex_execution_outcome_assessments"("assessment_id", "attempt_id") ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS "nex_outcome_attempt_id_idx" ON "nex_execution_outcome_assessments" USING btree ("attempt_id");
    CREATE INDEX IF NOT EXISTS "nex_outcome_assessed_at_idx" ON "nex_execution_outcome_assessments" USING btree ("assessed_at");
    CREATE INDEX IF NOT EXISTS "nex_outcome_append_seq_idx" ON "nex_execution_outcome_assessments" USING btree ("append_sequence");

    CREATE TRIGGER "nex_outcome_mut_trg" BEFORE UPDATE OR DELETE ON "nex_execution_outcome_assessments" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_outcome_trunc_trg" BEFORE TRUNCATE ON "nex_execution_outcome_assessments" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    -- 7. OUTCOME <-> EVIDENCE (Relacional Append-Only, sem UNIQUE de evidence para permitir repetição legítima de refs)
    CREATE TABLE IF NOT EXISTS "nex_execution_outcome_evidence" (
      "assessment_id" varchar NOT NULL,
      "evidence_id" varchar NOT NULL,
      "attempt_id" varchar NOT NULL,
      "position" integer NOT NULL CHECK ("position" >= 0),
      PRIMARY KEY ("assessment_id", "position"),
      FOREIGN KEY ("assessment_id", "attempt_id") REFERENCES "nex_execution_outcome_assessments"("assessment_id", "attempt_id") ON DELETE RESTRICT,
      FOREIGN KEY ("evidence_id", "attempt_id") REFERENCES "nex_execution_evidence"("evidence_id", "attempt_id") ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS "nex_out_evi_evidence_idx" ON "nex_execution_outcome_evidence" USING btree ("evidence_id");

    CREATE TRIGGER "nex_out_evi_mut_trg" BEFORE UPDATE OR DELETE ON "nex_execution_outcome_evidence" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_out_evi_trunc_trg" BEFORE TRUNCATE ON "nex_execution_outcome_evidence" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    -- 8. OUTCOME HEADS (Projeção Operacional Mutável, 1 row por attempt; FK composta same-Attempt)
    CREATE TABLE IF NOT EXISTS "nex_execution_outcome_heads" (
      "attempt_id" varchar PRIMARY KEY NOT NULL REFERENCES "nex_execution_attempt_heads"("attempt_id") ON DELETE RESTRICT,
      "latest_assessment_id" varchar NOT NULL,
      "assessment_count" integer NOT NULL CHECK ("assessment_count" >= 1),
      "updated_at" timestamp(3) with time zone NOT NULL,
      FOREIGN KEY ("latest_assessment_id", "attempt_id") REFERENCES "nex_execution_outcome_assessments"("assessment_id", "attempt_id") ON DELETE RESTRICT
    );

    -- 9. RECEIPTS (Append-Only; FK composta para Decision lineage)
    CREATE TABLE IF NOT EXISTS "nex_execution_receipts" (
      "receipt_id" varchar PRIMARY KEY NOT NULL,
      "append_sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      "decision_id" varchar NOT NULL,
      "kind" varchar NOT NULL CHECK ("kind" IN ('execution_outcome', 'policy_denial', 'authorization_denial', 'cancelled', 'no_eligible_route')),
      "verdict_summary" varchar NOT NULL,
      "reason_code" varchar NOT NULL,
      "safe_structured_facts" jsonb NOT NULL,
      "materialized_at" timestamp(3) with time zone NOT NULL,
      "route_evaluation_id" varchar,
      "attempt_id" varchar,
      "outcome_assessment_id" varchar,
      CONSTRAINT "nex_receipt_variant_chk" CHECK (
        ("kind" = 'execution_outcome' AND "route_evaluation_id" IS NOT NULL AND "attempt_id" IS NOT NULL AND "outcome_assessment_id" IS NOT NULL) OR
        ("kind" IN ('policy_denial', 'authorization_denial', 'cancelled', 'no_eligible_route') AND "route_evaluation_id" IS NULL AND "attempt_id" IS NULL AND "outcome_assessment_id" IS NULL)
      ),
      FOREIGN KEY ("outcome_assessment_id", "attempt_id") REFERENCES "nex_execution_outcome_assessments"("assessment_id", "attempt_id") ON DELETE RESTRICT,
      FOREIGN KEY ("attempt_id", "decision_id", "route_evaluation_id") REFERENCES "nex_execution_attempt_heads"("attempt_id", "decision_id", "route_evaluation_id") ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS "nex_receipts_decision_id_idx" ON "nex_execution_receipts" USING btree ("decision_id");
    CREATE INDEX IF NOT EXISTS "nex_receipts_attempt_id_idx" ON "nex_execution_receipts" USING btree ("attempt_id");
    CREATE INDEX IF NOT EXISTS "nex_receipts_append_seq_idx" ON "nex_execution_receipts" USING btree ("append_sequence");

    CREATE TRIGGER "nex_receipts_mut_trg" BEFORE UPDATE OR DELETE ON "nex_execution_receipts" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_receipts_trunc_trg" BEFORE TRUNCATE ON "nex_execution_receipts" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "nex_execution_receipts";
    DROP TABLE IF EXISTS "nex_execution_outcome_heads";
    DROP TABLE IF EXISTS "nex_execution_outcome_evidence";
    DROP TABLE IF EXISTS "nex_execution_outcome_assessments";
    DROP TABLE IF EXISTS "nex_execution_evidence_signals";
    DROP TABLE IF EXISTS "nex_execution_evidence";
    DROP TABLE IF EXISTS "nex_execution_signals";
    DROP TABLE IF EXISTS "nex_execution_attempt_events";
    DROP TABLE IF EXISTS "nex_execution_attempt_heads";
  `);
}
