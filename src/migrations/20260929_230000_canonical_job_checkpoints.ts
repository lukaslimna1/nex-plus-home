import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- NEX+ · Continuation Checkpoint Contracts & Store
    -- Checkpoint 0.86C-4A: Histórico Append-Only de Checkpoints Canônicos de Continuação
    CREATE TABLE IF NOT EXISTS "nex_job_checkpoints" (
      "checkpoint_id" varchar PRIMARY KEY NOT NULL,
      "append_sequence" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
      "job_id" varchar NOT NULL,
      "job_revision" integer NOT NULL CHECK ("job_revision" >= 1),
      "attempt_id" varchar NOT NULL,
      "outcome_assessment_id" varchar NOT NULL,
      "decision_material_context_id" varchar NOT NULL,
      "capability_revision_id" varchar NOT NULL,
      "capability_domain_effect" varchar NOT NULL CHECK ("capability_domain_effect" IN ('none', 'may_mutate_domain')),
      "binding_revision_id" varchar NOT NULL,
      "binding_domain_effect_attested" varchar NOT NULL CHECK ("binding_domain_effect_attested" IN ('none', 'may_mutate_domain')),
      "route_revision_id" varchar NOT NULL,
      "route_domain_effect" varchar NOT NULL CHECK ("route_domain_effect" IN ('none', 'may_mutate_domain')),
      "effective_is_domain_mutating" boolean NOT NULL,
      "continuation_directive" varchar NOT NULL CHECK ("continuation_directive" IN ('stop', 'new_route_evaluation_required', 'human_escalation_required')),
      "continuation_reason_code" varchar NOT NULL,
      "recorded_at" timestamp(3) with time zone NOT NULL,
      CONSTRAINT "nex_job_checkpoints_mutating_chk" CHECK (
        "effective_is_domain_mutating" = (
          "capability_domain_effect" = 'may_mutate_domain' OR
          "binding_domain_effect_attested" = 'may_mutate_domain' OR
          "route_domain_effect" = 'may_mutate_domain'
        )
      ),
      FOREIGN KEY ("job_id", "job_revision") REFERENCES "nex_job_events"("job_id", "revision") ON DELETE RESTRICT,
      FOREIGN KEY ("outcome_assessment_id", "attempt_id") REFERENCES "nex_execution_outcome_assessments"("assessment_id", "attempt_id") ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS "nex_job_checkpoints_job_id_idx" ON "nex_job_checkpoints" USING btree ("job_id");
    CREATE INDEX IF NOT EXISTS "nex_job_checkpoints_attempt_id_idx" ON "nex_job_checkpoints" USING btree ("attempt_id");
    CREATE INDEX IF NOT EXISTS "nex_job_checkpoints_recorded_at_idx" ON "nex_job_checkpoints" USING btree ("recorded_at");
    CREATE INDEX IF NOT EXISTS "nex_job_checkpoints_append_seq_idx" ON "nex_job_checkpoints" USING btree ("append_sequence");

    CREATE TRIGGER "nex_job_checkpoints_mut_trg" BEFORE UPDATE OR DELETE ON "nex_job_checkpoints" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_job_checkpoints_trunc_trg" BEFORE TRUNCATE ON "nex_job_checkpoints" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "nex_job_checkpoints";
  `);
}
