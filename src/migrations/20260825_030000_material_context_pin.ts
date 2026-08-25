import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- 1. MATERIAL CONTEXT PINS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_material_context_pins" (
      "pin_id" varchar PRIMARY KEY NOT NULL,
      "actor_kind" varchar NOT NULL CHECK ("actor_kind" IN ('human', 'max', 'system', 'integration')),
      "actor_payload" jsonb NOT NULL,
      "user_id" varchar,
      "session_ref" varchar,
      "subject_type" varchar,
      "subject_id" varchar,
      "flow_type" varchar,
      "flow_id" varchar,
      "correlation_id" varchar,
      "channel" varchar,
      "pinned_at" timestamp(3) with time zone NOT NULL,
      CONSTRAINT "nex_pin_id_chk" CHECK (length(trim("pin_id")) > 0),
      CONSTRAINT "nex_pin_subject_pair_chk" CHECK (
        ("subject_type" IS NULL AND "subject_id" IS NULL) OR
        ("subject_type" IS NOT NULL AND "subject_id" IS NOT NULL AND length(trim("subject_type")) > 0 AND length(trim("subject_id")) > 0)
      ),
      CONSTRAINT "nex_pin_flow_pair_chk" CHECK (
        ("flow_type" IS NULL AND "flow_id" IS NULL) OR
        ("flow_type" IS NOT NULL AND "flow_id" IS NOT NULL AND length(trim("flow_type")) > 0 AND length(trim("flow_id")) > 0)
      ),
      CONSTRAINT "nex_pin_session_user_chk" CHECK (
        ("session_ref" IS NULL) OR
        ("session_ref" IS NOT NULL AND "user_id" IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_pin_user_id_idx" ON "nex_material_context_pins" USING btree ("user_id");
    CREATE INDEX IF NOT EXISTS "nex_pin_session_ref_idx" ON "nex_material_context_pins" USING btree ("session_ref");
    CREATE INDEX IF NOT EXISTS "nex_pin_pinned_at_idx" ON "nex_material_context_pins" USING btree ("pinned_at");
    CREATE INDEX IF NOT EXISTS "nex_pin_correlation_id_idx" ON "nex_material_context_pins" USING btree ("correlation_id");

    -- 2. MATERIAL CONTEXT ITEMS (Relacionais Ordenados por position, Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_material_context_items" (
      "pin_id" varchar NOT NULL REFERENCES "nex_material_context_pins"("pin_id") ON DELETE RESTRICT,
      "position" integer NOT NULL CHECK ("position" >= 0),
      "kind" varchar NOT NULL CHECK ("kind" IN (
        'input_ref',
        'observation_ref',
        'canonical_projection_ref',
        'evidence_ref',
        'precedent_ref',
        'resource_ref',
        'aspect_snapshot'
      )),
      "input_id" varchar REFERENCES "nex_input_records"("input_id") ON DELETE RESTRICT,
      "observation_id" varchar REFERENCES "nex_observation_records"("observation_id") ON DELETE RESTRICT,
      "projection_revision_id" varchar REFERENCES "nex_canonical_projection_revisions"("projection_revision_id") ON DELETE RESTRICT,
      "evidence_artifact_id" varchar REFERENCES "nex_evidence_artifacts"("artifact_id") ON DELETE RESTRICT,
      "precedent_id" varchar REFERENCES "nex_contextual_precedents"("precedent_id") ON DELETE RESTRICT,
      "resource_module_key" varchar,
      "resource_type" varchar,
      "resource_id" varchar,
      "aspect_target_kind" varchar CHECK ("aspect_target_kind" IS NULL OR "aspect_target_kind" IN ('resource', 'scope')),
      "aspect_target_module_key" varchar,
      "aspect_target_resource_type" varchar,
      "aspect_target_resource_id" varchar,
      "aspect_target_scope_type" varchar,
      "aspect_target_scope_id" varchar,
      "aspect_key" varchar,
      "snapshot_value" jsonb,
      PRIMARY KEY ("pin_id", "position"),
      CONSTRAINT "nex_item_variant_chk" CHECK (
        -- 1. input_ref
        ("kind" = 'input_ref' AND "input_id" IS NOT NULL AND "observation_id" IS NULL AND "projection_revision_id" IS NULL AND "evidence_artifact_id" IS NULL AND "precedent_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND "aspect_target_kind" IS NULL AND "aspect_target_module_key" IS NULL AND "aspect_target_resource_type" IS NULL AND "aspect_target_resource_id" IS NULL AND "aspect_target_scope_type" IS NULL AND "aspect_target_scope_id" IS NULL AND "aspect_key" IS NULL AND "snapshot_value" IS NULL) OR

        -- 2. observation_ref
        ("kind" = 'observation_ref' AND "observation_id" IS NOT NULL AND "input_id" IS NULL AND "projection_revision_id" IS NULL AND "evidence_artifact_id" IS NULL AND "precedent_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND "aspect_target_kind" IS NULL AND "aspect_target_module_key" IS NULL AND "aspect_target_resource_type" IS NULL AND "aspect_target_resource_id" IS NULL AND "aspect_target_scope_type" IS NULL AND "aspect_target_scope_id" IS NULL AND "aspect_key" IS NULL AND "snapshot_value" IS NULL) OR

        -- 3. canonical_projection_ref
        ("kind" = 'canonical_projection_ref' AND "projection_revision_id" IS NOT NULL AND "input_id" IS NULL AND "observation_id" IS NULL AND "evidence_artifact_id" IS NULL AND "precedent_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND "aspect_target_kind" IS NULL AND "aspect_target_module_key" IS NULL AND "aspect_target_resource_type" IS NULL AND "aspect_target_resource_id" IS NULL AND "aspect_target_scope_type" IS NULL AND "aspect_target_scope_id" IS NULL AND "aspect_key" IS NULL AND "snapshot_value" IS NULL) OR

        -- 4. evidence_ref
        ("kind" = 'evidence_ref' AND "evidence_artifact_id" IS NOT NULL AND "input_id" IS NULL AND "observation_id" IS NULL AND "projection_revision_id" IS NULL AND "precedent_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND "aspect_target_kind" IS NULL AND "aspect_target_module_key" IS NULL AND "aspect_target_resource_type" IS NULL AND "aspect_target_resource_id" IS NULL AND "aspect_target_scope_type" IS NULL AND "aspect_target_scope_id" IS NULL AND "aspect_key" IS NULL AND "snapshot_value" IS NULL) OR

        -- 5. precedent_ref
        ("kind" = 'precedent_ref' AND "precedent_id" IS NOT NULL AND "input_id" IS NULL AND "observation_id" IS NULL AND "projection_revision_id" IS NULL AND "evidence_artifact_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND "aspect_target_kind" IS NULL AND "aspect_target_module_key" IS NULL AND "aspect_target_resource_type" IS NULL AND "aspect_target_resource_id" IS NULL AND "aspect_target_scope_type" IS NULL AND "aspect_target_scope_id" IS NULL AND "aspect_key" IS NULL AND "snapshot_value" IS NULL) OR

        -- 6. resource_ref
        ("kind" = 'resource_ref' AND "resource_module_key" IS NOT NULL AND length(trim("resource_module_key")) > 0 AND "resource_type" IS NOT NULL AND length(trim("resource_type")) > 0 AND "resource_id" IS NOT NULL AND length(trim("resource_id")) > 0 AND "input_id" IS NULL AND "observation_id" IS NULL AND "projection_revision_id" IS NULL AND "evidence_artifact_id" IS NULL AND "precedent_id" IS NULL AND "aspect_target_kind" IS NULL AND "aspect_target_module_key" IS NULL AND "aspect_target_resource_type" IS NULL AND "aspect_target_resource_id" IS NULL AND "aspect_target_scope_type" IS NULL AND "aspect_target_scope_id" IS NULL AND "aspect_key" IS NULL AND "snapshot_value" IS NULL) OR

        -- 7. aspect_snapshot
        ("kind" = 'aspect_snapshot' AND "aspect_key" IS NOT NULL AND length(trim("aspect_key")) > 0 AND "snapshot_value" IS NOT NULL AND "input_id" IS NULL AND "observation_id" IS NULL AND "projection_revision_id" IS NULL AND "evidence_artifact_id" IS NULL AND "precedent_id" IS NULL AND "resource_module_key" IS NULL AND "resource_type" IS NULL AND "resource_id" IS NULL AND (
          ("aspect_target_kind" = 'resource' AND "aspect_target_module_key" IS NOT NULL AND length(trim("aspect_target_module_key")) > 0 AND "aspect_target_resource_type" IS NOT NULL AND length(trim("aspect_target_resource_type")) > 0 AND "aspect_target_resource_id" IS NOT NULL AND length(trim("aspect_target_resource_id")) > 0 AND "aspect_target_scope_type" IS NULL AND "aspect_target_scope_id" IS NULL) OR
          ("aspect_target_kind" = 'scope' AND "aspect_target_module_key" IS NOT NULL AND length(trim("aspect_target_module_key")) > 0 AND "aspect_target_scope_type" IS NOT NULL AND length(trim("aspect_target_scope_type")) > 0 AND "aspect_target_scope_id" IS NOT NULL AND length(trim("aspect_target_scope_id")) > 0 AND "aspect_target_resource_type" IS NULL AND "aspect_target_resource_id" IS NULL)
        ))
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_item_input_idx" ON "nex_material_context_items" USING btree ("input_id");
    CREATE INDEX IF NOT EXISTS "nex_item_observation_idx" ON "nex_material_context_items" USING btree ("observation_id");
    CREATE INDEX IF NOT EXISTS "nex_item_projection_idx" ON "nex_material_context_items" USING btree ("projection_revision_id");
    CREATE INDEX IF NOT EXISTS "nex_item_evidence_idx" ON "nex_material_context_items" USING btree ("evidence_artifact_id");
    CREATE INDEX IF NOT EXISTS "nex_item_precedent_idx" ON "nex_material_context_items" USING btree ("precedent_id");
    CREATE INDEX IF NOT EXISTS "nex_item_resource_idx" ON "nex_material_context_items" USING btree ("resource_module_key", "resource_type", "resource_id");

    -- 3. TRIGGERS DE PROTEÇÃO APPEND-ONLY
    CREATE TRIGGER "nex_material_context_pins_mut_trg" BEFORE UPDATE OR DELETE ON "nex_material_context_pins" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_material_context_pins_trunc_trg" BEFORE TRUNCATE ON "nex_material_context_pins" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();

    CREATE TRIGGER "nex_material_context_items_mut_trg" BEFORE UPDATE OR DELETE ON "nex_material_context_items" FOR EACH ROW EXECUTE FUNCTION nex_reject_append_only_mutation();
    CREATE TRIGGER "nex_material_context_items_trunc_trg" BEFORE TRUNCATE ON "nex_material_context_items" FOR EACH STATEMENT EXECUTE FUNCTION nex_reject_append_only_mutation();
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "nex_material_context_items";
    DROP TABLE IF EXISTS "nex_material_context_pins";
  `);
}
