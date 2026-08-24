import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- 1. INGRESS CONTENTS METADATA (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_ingress_contents" (
      "content_id" varchar PRIMARY KEY NOT NULL,
      "actor_kind" varchar NOT NULL CHECK ("actor_kind" IN ('human', 'max', 'system', 'integration')),
      "actor_payload" jsonb NOT NULL,
      "user_id" varchar,
      "session_ref" varchar,
      "subject_type" varchar,
      "subject_id" varchar,
      "source_ref_id" varchar REFERENCES "nex_source_refs"("source_id") ON DELETE RESTRICT,
      "declared_mime_type" varchar,
      "verified_mime_type" varchar NOT NULL,
      "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
      "byte_size" bigint NOT NULL CHECK ("byte_size" >= 0),
      "storage_backend" varchar NOT NULL,
      "storage_key" varchar NOT NULL,
      "received_at" timestamp(3) with time zone NOT NULL,
      "expires_at" timestamp(3) with time zone,
      CONSTRAINT "nex_ing_content_id_chk" CHECK (length(trim("content_id")) > 0),
      CONSTRAINT "nex_ing_verified_mime_chk" CHECK (length(trim("verified_mime_type")) > 0),
      CONSTRAINT "nex_ing_storage_backend_chk" CHECK (length(trim("storage_backend")) > 0),
      CONSTRAINT "nex_ing_storage_key_chk" CHECK (length(trim("storage_key")) > 0),
      CONSTRAINT "nex_ing_subject_pair_chk" CHECK (
        ("subject_type" IS NULL AND "subject_id" IS NULL) OR
        ("subject_type" IS NOT NULL AND "subject_id" IS NOT NULL AND length(trim("subject_type")) > 0 AND length(trim("subject_id")) > 0)
      ),
      CONSTRAINT "nex_ing_session_user_chk" CHECK (
        ("session_ref" IS NULL) OR
        ("session_ref" IS NOT NULL AND "user_id" IS NOT NULL)
      ),
      CONSTRAINT "nex_ing_expires_at_chk" CHECK (
        ("expires_at" IS NULL) OR
        ("expires_at" > "received_at")
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_ing_sha256_idx" ON "nex_ingress_contents" USING btree ("sha256");
    CREATE INDEX IF NOT EXISTS "nex_ing_user_id_idx" ON "nex_ingress_contents" USING btree ("user_id");
    CREATE INDEX IF NOT EXISTS "nex_ing_session_ref_idx" ON "nex_ingress_contents" USING btree ("session_ref");
    CREATE INDEX IF NOT EXISTS "nex_ing_source_ref_id_idx" ON "nex_ingress_contents" USING btree ("source_ref_id");
    CREATE INDEX IF NOT EXISTS "nex_ing_received_at_idx" ON "nex_ingress_contents" USING btree ("received_at");
    CREATE INDEX IF NOT EXISTS "nex_ing_expires_at_idx" ON "nex_ingress_contents" USING btree ("expires_at");

    -- 2. INPUT RECORDS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_input_records" (
      "input_id" varchar PRIMARY KEY NOT NULL,
      "actor_kind" varchar NOT NULL CHECK ("actor_kind" IN ('human', 'max', 'system', 'integration')),
      "actor_payload" jsonb NOT NULL,
      "user_id" varchar,
      "session_ref" varchar,
      "subject_type" varchar,
      "subject_id" varchar,
      "source_ref_id" varchar REFERENCES "nex_source_refs"("source_id") ON DELETE RESTRICT,
      "source_event_source" varchar,
      "source_event_id" varchar,
      "occurred_at" timestamp(3) with time zone,
      "received_at" timestamp(3) with time zone NOT NULL,
      "channel" varchar,
      "correlation_id" varchar,
      CONSTRAINT "nex_inp_input_id_chk" CHECK (length(trim("input_id")) > 0),
      CONSTRAINT "nex_inp_subject_pair_chk" CHECK (
        ("subject_type" IS NULL AND "subject_id" IS NULL) OR
        ("subject_type" IS NOT NULL AND "subject_id" IS NOT NULL AND length(trim("subject_type")) > 0 AND length(trim("subject_id")) > 0)
      ),
      CONSTRAINT "nex_inp_source_event_pair_chk" CHECK (
        ("source_event_source" IS NULL AND "source_event_id" IS NULL) OR
        ("source_event_source" IS NOT NULL AND "source_event_id" IS NOT NULL AND length(trim("source_event_source")) > 0 AND length(trim("source_event_id")) > 0)
      ),
      CONSTRAINT "nex_inp_session_user_chk" CHECK (
        ("session_ref" IS NULL) OR
        ("session_ref" IS NOT NULL AND "user_id" IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "nex_inp_source_event_uidx" ON "nex_input_records" ("source_event_source", "source_event_id")
      WHERE "source_event_source" IS NOT NULL AND "source_event_id" IS NOT NULL;
    CREATE INDEX IF NOT EXISTS "nex_inp_user_id_idx" ON "nex_input_records" USING btree ("user_id");
    CREATE INDEX IF NOT EXISTS "nex_inp_session_ref_idx" ON "nex_input_records" USING btree ("session_ref");
    CREATE INDEX IF NOT EXISTS "nex_inp_received_at_idx" ON "nex_input_records" USING btree ("received_at");
    CREATE INDEX IF NOT EXISTS "nex_inp_correlation_id_idx" ON "nex_input_records" USING btree ("correlation_id");

    -- 3. INPUT PARTS (Relacionais Ordenadas por position, Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_input_parts" (
      "input_id" varchar NOT NULL REFERENCES "nex_input_records"("input_id") ON DELETE RESTRICT,
      "position" integer NOT NULL CHECK ("position" >= 0),
      "kind" varchar NOT NULL CHECK ("kind" IN ('text', 'content_ref', 'event_ref', 'resource_ref', 'evidence_ref')),
      "text_value" text,
      "ingress_content_id" varchar REFERENCES "nex_ingress_contents"("content_id") ON DELETE RESTRICT,
      "event_id" varchar,
      "resource_module_key" varchar,
      "resource_type" varchar,
      "resource_id" varchar,
      "evidence_artifact_id" varchar REFERENCES "nex_evidence_artifacts"("artifact_id") ON DELETE RESTRICT,
      PRIMARY KEY ("input_id", "position"),
      CONSTRAINT "nex_part_variant_chk" CHECK (
        ("kind" = 'text' AND "text_value" IS NOT NULL AND length(trim("text_value")) > 0 AND "ingress_content_id" IS NULL AND "event_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND "evidence_artifact_id" IS NULL) OR
        ("kind" = 'content_ref' AND "ingress_content_id" IS NOT NULL AND "text_value" IS NULL AND "event_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND "evidence_artifact_id" IS NULL) OR
        ("kind" = 'event_ref' AND "event_id" IS NOT NULL AND length(trim("event_id")) > 0 AND "text_value" IS NULL AND "ingress_content_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND "evidence_artifact_id" IS NULL) OR
        ("kind" = 'resource_ref' AND "resource_module_key" IS NOT NULL AND length(trim("resource_module_key")) > 0 AND "resource_type" IS NOT NULL AND length(trim("resource_type")) > 0 AND "resource_id" IS NOT NULL AND length(trim("resource_id")) > 0 AND "text_value" IS NULL AND "ingress_content_id" IS NULL AND "event_id" IS NULL AND "evidence_artifact_id" IS NULL) OR
        ("kind" = 'evidence_ref' AND "evidence_artifact_id" IS NOT NULL AND "text_value" IS NULL AND "ingress_content_id" IS NULL AND "event_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_part_ingress_content_idx" ON "nex_input_parts" USING btree ("ingress_content_id");
    CREATE INDEX IF NOT EXISTS "nex_part_event_id_idx" ON "nex_input_parts" USING btree ("event_id");
    CREATE INDEX IF NOT EXISTS "nex_part_evidence_artifact_idx" ON "nex_input_parts" USING btree ("evidence_artifact_id");
    CREATE INDEX IF NOT EXISTS "nex_part_resource_idx" ON "nex_input_parts" USING btree ("resource_module_key", "resource_type", "resource_id");

    -- 4. TRIGGERS DE PROTEÇÃO APPEND-ONLY
    CREATE TRIGGER "nex_ingress_contents_mut_trg" BEFORE UPDATE OR DELETE ON "nex_ingress_contents" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_ingress_contents_trunc_trg" BEFORE TRUNCATE ON "nex_ingress_contents" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    CREATE TRIGGER "nex_input_records_mut_trg" BEFORE UPDATE OR DELETE ON "nex_input_records" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_input_records_trunc_trg" BEFORE TRUNCATE ON "nex_input_records" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    CREATE TRIGGER "nex_input_parts_mut_trg" BEFORE UPDATE OR DELETE ON "nex_input_parts" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_input_parts_trunc_trg" BEFORE TRUNCATE ON "nex_input_parts" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "nex_input_parts";
    DROP TABLE IF EXISTS "nex_input_records";
    DROP TABLE IF EXISTS "nex_ingress_contents";
  `);
}
