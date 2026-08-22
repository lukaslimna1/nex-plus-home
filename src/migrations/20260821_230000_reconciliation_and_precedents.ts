import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- 1. RECONCILIATION CASE REVISIONS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_reconciliation_case_revisions" (
      "case_id" varchar NOT NULL,
      "version" integer NOT NULL CHECK ("version" >= 1),
      "subject_domain" varchar NOT NULL,
      "subject_entity_type" varchar NOT NULL,
      "subject_entity_id" varchar NOT NULL,
      "observation_ids" jsonb NOT NULL,
      "review_ids" jsonb NOT NULL,
      "lifecycle" varchar NOT NULL CHECK ("lifecycle" IN ('open', 'resolved')),
      "status" varchar NOT NULL CHECK ("status" IN (
        'open', 'awaiting_evidence', 'divergent', 'inconclusive',
        'validated', 'partially_validated', 'reclassified'
      )),
      "opened_at" timestamp(3) with time zone NOT NULL,
      "resolved_at" timestamp(3) with time zone,
      "resolution_summary" text,
      "materialized_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("case_id", "version"),
      CONSTRAINT "nex_rec_case_id_chk" CHECK (length(trim("case_id")) > 0),
      CONSTRAINT "nex_rec_subject_domain_chk" CHECK (length(trim("subject_domain")) > 0),
      CONSTRAINT "nex_rec_subject_type_chk" CHECK (length(trim("subject_entity_type")) > 0),
      CONSTRAINT "nex_rec_subject_id_chk" CHECK (length(trim("subject_entity_id")) > 0),
      CONSTRAINT "nex_rec_lifecycle_chk" CHECK (
        ("lifecycle" = 'open' AND "status" IN ('open', 'awaiting_evidence', 'divergent', 'inconclusive') AND "resolved_at" IS NULL) OR
        ("lifecycle" = 'resolved' AND "status" IN ('validated', 'partially_validated', 'divergent', 'inconclusive', 'reclassified') AND "resolved_at" IS NOT NULL AND "resolution_summary" IS NOT NULL AND length(trim("resolution_summary")) > 0)
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_rec_subject_idx" ON "nex_reconciliation_case_revisions" USING btree ("subject_domain", "subject_entity_type", "subject_entity_id");
    CREATE INDEX IF NOT EXISTS "nex_rec_lifecycle_status_idx" ON "nex_reconciliation_case_revisions" USING btree ("lifecycle", "status");
    CREATE INDEX IF NOT EXISTS "nex_rec_opened_at_idx" ON "nex_reconciliation_case_revisions" USING btree ("opened_at");

    -- 2. RECONCILIATION CASE HEADS (Ponteiro operacional mínimo apontando atomicamente para a versão vigente)
    CREATE TABLE IF NOT EXISTS "nex_reconciliation_case_heads" (
      "case_id" varchar PRIMARY KEY NOT NULL,
      "current_version" integer NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      FOREIGN KEY ("case_id", "current_version") REFERENCES "nex_reconciliation_case_revisions"("case_id", "version") ON DELETE RESTRICT
    );

    -- 3. CONTEXTUAL PRECEDENTS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_contextual_precedents" (
      "precedent_id" varchar PRIMARY KEY NOT NULL,
      "review_event_id" varchar NOT NULL REFERENCES "nex_review_events"("review_id") ON DELETE RESTRICT,
      "context_summary" text NOT NULL,
      "applicability_conditions" jsonb NOT NULL,
      "policy_proposal_ref" varchar,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "nex_prec_id_chk" CHECK (length(trim("precedent_id")) > 0),
      CONSTRAINT "nex_prec_summary_chk" CHECK (length(trim("context_summary")) > 0)
    );

    CREATE INDEX IF NOT EXISTS "nex_prec_review_id_idx" ON "nex_contextual_precedents" USING btree ("review_event_id");
    CREATE INDEX IF NOT EXISTS "nex_prec_created_at_idx" ON "nex_contextual_precedents" USING btree ("created_at");

    -- 4. FK NA TABELA CANONICAL PROJECTIONS
    ALTER TABLE "nex_canonical_projection_revisions"
      ADD CONSTRAINT "nex_proj_reconciliation_case_fk"
      FOREIGN KEY ("reconciliation_case_id")
      REFERENCES "nex_reconciliation_case_heads"("case_id")
      ON DELETE RESTRICT;

    -- 5. TRIGGERS DE PROTEÇÃO APPEND-ONLY NAS TABELAS 0.85D
    CREATE TRIGGER "nex_rec_revisions_mut_trg" BEFORE UPDATE OR DELETE ON "nex_reconciliation_case_revisions" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_rec_revisions_trunc_trg" BEFORE TRUNCATE ON "nex_reconciliation_case_revisions" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    CREATE TRIGGER "nex_precedents_mut_trg" BEFORE UPDATE OR DELETE ON "nex_contextual_precedents" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_precedents_trunc_trg" BEFORE TRUNCATE ON "nex_contextual_precedents" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    -- Remove FK de canonical projections
    ALTER TABLE "nex_canonical_projection_revisions" DROP CONSTRAINT IF EXISTS "nex_proj_reconciliation_case_fk";

    -- Remove tabelas do delta 0.85D
    DROP TABLE IF EXISTS "nex_contextual_precedents";
    DROP TABLE IF EXISTS "nex_reconciliation_case_heads";
    DROP TABLE IF EXISTS "nex_reconciliation_case_revisions";
  `);
}
