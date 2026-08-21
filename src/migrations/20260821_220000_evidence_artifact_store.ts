import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- 1. SOURCE REFS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_source_refs" (
      "source_id" varchar PRIMARY KEY NOT NULL,
      "kind" varchar NOT NULL CHECK ("kind" IN ('url', 'api_endpoint', 'system_feed', 'human_statement', 'document_source', 'internal_process')),
      "name" varchar NOT NULL,
      "location_or_uri" text,
      "safe_metadata" jsonb,
      "created_at" timestamp(3) with time zone NOT NULL
    );

    CREATE INDEX IF NOT EXISTS "nex_src_created_at_idx" ON "nex_source_refs" USING btree ("created_at");

    -- 2. EVIDENCE ARTIFACTS METADATA (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_evidence_artifacts" (
      "artifact_id" varchar PRIMARY KEY NOT NULL,
      "kind" varchar NOT NULL CHECK ("kind" IN ('url_resource', 'api_response', 'document', 'screenshot', 'snapshot', 'text_snippet', 'human_message')),
      "source_ref_id" varchar REFERENCES "nex_source_refs"("source_id") ON DELETE RESTRICT,
      "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
      "byte_size" bigint NOT NULL CHECK ("byte_size" >= 0),
      "mime_type" varchar NOT NULL,
      "storage_backend" varchar NOT NULL,
      "storage_key" varchar NOT NULL,
      "safe_description" text,
      "captured_at" timestamp(3) with time zone NOT NULL,
      "sensitivity" varchar NOT NULL CHECK ("sensitivity" IN ('NORMAL', 'LOCAL_ONLY')),
      "contains_secret_material" boolean NOT NULL CHECK ("contains_secret_material" = false),
      "redaction_applied" boolean NOT NULL,
      "redaction_method_ref" varchar,
      "retention_class" varchar NOT NULL CHECK ("retention_class" = 'durable_evidence'),
      CONSTRAINT "nex_evidence_redaction_chk" CHECK (
        ("redaction_applied" = true AND "redaction_method_ref" IS NOT NULL AND length(trim("redaction_method_ref")) > 0) OR
        ("redaction_applied" = false)
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_art_sha256_idx" ON "nex_evidence_artifacts" USING btree ("sha256");
    CREATE INDEX IF NOT EXISTS "nex_art_captured_at_idx" ON "nex_evidence_artifacts" USING btree ("captured_at");

    -- 3. EVIDENCE ARTIFACT ATTEMPT LINKS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_evidence_artifact_attempt_links" (
      "artifact_id" varchar NOT NULL REFERENCES "nex_evidence_artifacts"("artifact_id") ON DELETE RESTRICT,
      "attempt_id" varchar NOT NULL,
      "linked_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("artifact_id", "attempt_id")
    );

    -- 4. VÍNCULOS DE FOREIGN KEYS NAS TABELAS 0.85B
    ALTER TABLE "nex_observation_evidence_refs"
      ADD CONSTRAINT "nex_obs_evidence_fk"
      FOREIGN KEY ("evidence_artifact_id")
      REFERENCES "nex_evidence_artifacts"("artifact_id")
      ON DELETE RESTRICT;

    ALTER TABLE "nex_review_event_evidence"
      ADD CONSTRAINT "nex_review_evidence_fk"
      FOREIGN KEY ("evidence_artifact_id")
      REFERENCES "nex_evidence_artifacts"("artifact_id")
      ON DELETE RESTRICT;

    ALTER TABLE "nex_observation_sources"
      ADD CONSTRAINT "nex_obs_sources_fk"
      FOREIGN KEY ("source_ref_id")
      REFERENCES "nex_source_refs"("source_id")
      ON DELETE RESTRICT;

    -- 5. TRIGGERS DE PROTEÇÃO APPEND-ONLY NAS TABELAS 0.85C
    CREATE TRIGGER "nex_source_refs_mut_trg" BEFORE UPDATE OR DELETE ON "nex_source_refs" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_source_refs_trunc_trg" BEFORE TRUNCATE ON "nex_source_refs" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    CREATE TRIGGER "nex_artifacts_mut_trg" BEFORE UPDATE OR DELETE ON "nex_evidence_artifacts" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_artifacts_trunc_trg" BEFORE TRUNCATE ON "nex_evidence_artifacts" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    CREATE TRIGGER "nex_artifact_attempts_mut_trg" BEFORE UPDATE OR DELETE ON "nex_evidence_artifact_attempt_links" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_artifact_attempts_trunc_trg" BEFORE TRUNCATE ON "nex_evidence_artifact_attempt_links" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    -- Remove FKs adicionadas às tabelas 0.85B
    ALTER TABLE "nex_observation_sources" DROP CONSTRAINT IF EXISTS "nex_obs_sources_fk";
    ALTER TABLE "nex_review_event_evidence" DROP CONSTRAINT IF EXISTS "nex_review_evidence_fk";
    ALTER TABLE "nex_observation_evidence_refs" DROP CONSTRAINT IF EXISTS "nex_obs_evidence_fk";

    -- Remove tabelas do delta 0.85C
    DROP TABLE IF EXISTS "nex_evidence_artifact_attempt_links";
    DROP TABLE IF EXISTS "nex_evidence_artifacts";
    DROP TABLE IF EXISTS "nex_source_refs";
  `);
}
