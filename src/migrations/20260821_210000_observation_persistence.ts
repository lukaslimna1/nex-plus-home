import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- 1. OBSERVATION RECORDS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_observation_records" (
      "observation_id" varchar PRIMARY KEY NOT NULL,
      "domain" varchar NOT NULL,
      "entity_type" varchar NOT NULL,
      "entity_id" varchar NOT NULL,
      "observed_claim" varchar NOT NULL,
      "raw_value" jsonb NOT NULL,
      "has_normalized_value" boolean DEFAULT false NOT NULL,
      "normalized_value" jsonb,
      "actor_kind" varchar NOT NULL CHECK ("actor_kind" IN ('human', 'max', 'system', 'integration')),
      "actor_payload" jsonb NOT NULL,
      "channel" varchar,
      "acquisition_method" varchar,
      "provenance" jsonb,
      "execution_evidence_ref" varchar,
      "occurred_at" timestamp(3) with time zone,
      "observed_at" timestamp(3) with time zone NOT NULL,
      "captured_at" timestamp(3) with time zone NOT NULL,
      "received_at" timestamp(3) with time zone
    );

    CREATE INDEX IF NOT EXISTS "nex_obs_subject_idx" ON "nex_observation_records" USING btree ("domain", "entity_type", "entity_id");
    CREATE INDEX IF NOT EXISTS "nex_obs_observed_at_idx" ON "nex_observation_records" USING btree ("observed_at");
    CREATE INDEX IF NOT EXISTS "nex_obs_captured_at_idx" ON "nex_observation_records" USING btree ("captured_at");

    -- 2. OBSERVATION SOURCE REFS
    CREATE TABLE IF NOT EXISTS "nex_observation_sources" (
      "observation_id" varchar NOT NULL REFERENCES "nex_observation_records"("observation_id") ON DELETE CASCADE,
      "source_ref_id" varchar NOT NULL,
      PRIMARY KEY ("observation_id", "source_ref_id")
    );

    -- 3. OBSERVATION EVIDENCE REFS
    CREATE TABLE IF NOT EXISTS "nex_observation_evidence_refs" (
      "observation_id" varchar NOT NULL REFERENCES "nex_observation_records"("observation_id") ON DELETE CASCADE,
      "evidence_artifact_id" varchar NOT NULL,
      PRIMARY KEY ("observation_id", "evidence_artifact_id")
    );

    -- 4. INGESTION IDEMPOTENCY KEYS
    CREATE TABLE IF NOT EXISTS "nex_observation_ingest_keys" (
      "idempotency_scope" varchar NOT NULL,
      "idempotency_key" varchar NOT NULL,
      "observation_id" varchar NOT NULL REFERENCES "nex_observation_records"("observation_id") ON DELETE CASCADE,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("idempotency_scope", "idempotency_key")
    );

    -- 5. REVIEW EVENTS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_review_events" (
      "review_id" varchar PRIMARY KEY NOT NULL,
      "actor_kind" varchar NOT NULL CHECK ("actor_kind" IN ('human', 'max', 'system', 'integration')),
      "actor_payload" jsonb NOT NULL,
      "decision" varchar NOT NULL CHECK ("decision" IN (
        'provisional', 'corroborated', 'contested', 'divergent',
        'awaiting_evidence', 'inconclusive', 'canonical_promoted',
        'canonical_reclassified', 'rejected'
      )),
      "canonical_action" varchar CHECK ("canonical_action" IN ('promote', 'reclassify')),
      "target_canonical_state" jsonb,
      "target_base_revision_id" varchar,
      "justification" text NOT NULL CHECK (length(trim("justification")) > 0),
      "reviewed_at" timestamp(3) with time zone NOT NULL,
      CONSTRAINT "nex_review_canonical_coherence_chk" CHECK (
        ("decision" = 'canonical_promoted' AND "canonical_action" = 'promote' AND "target_canonical_state" IS NOT NULL) OR
        ("decision" = 'canonical_reclassified' AND "canonical_action" = 'reclassify' AND "target_canonical_state" IS NOT NULL) OR
        ("decision" NOT IN ('canonical_promoted', 'canonical_reclassified') AND "canonical_action" IS NULL AND "target_canonical_state" IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_review_reviewed_at_idx" ON "nex_review_events" USING btree ("reviewed_at");

    -- 6. REVIEW EVENT OBSERVATIONS
    CREATE TABLE IF NOT EXISTS "nex_review_event_observations" (
      "review_id" varchar NOT NULL REFERENCES "nex_review_events"("review_id") ON DELETE CASCADE,
      "observation_id" varchar NOT NULL REFERENCES "nex_observation_records"("observation_id"),
      PRIMARY KEY ("review_id", "observation_id")
    );

    -- 7. REVIEW EVENT PREVIOUS REVIEWS
    CREATE TABLE IF NOT EXISTS "nex_review_event_previous_reviews" (
      "review_id" varchar NOT NULL REFERENCES "nex_review_events"("review_id") ON DELETE CASCADE,
      "previous_review_id" varchar NOT NULL REFERENCES "nex_review_events"("review_id"),
      PRIMARY KEY ("review_id", "previous_review_id")
    );

    -- 8. REVIEW EVENT EVIDENCE REFS
    CREATE TABLE IF NOT EXISTS "nex_review_event_evidence" (
      "review_id" varchar NOT NULL REFERENCES "nex_review_events"("review_id") ON DELETE CASCADE,
      "evidence_artifact_id" varchar NOT NULL,
      PRIMARY KEY ("review_id", "evidence_artifact_id")
    );

    -- 9. CANONICAL PROJECTION REVISIONS (Append-Only)
    CREATE TABLE IF NOT EXISTS "nex_canonical_projection_revisions" (
      "projection_revision_id" varchar PRIMARY KEY NOT NULL,
      "domain" varchar NOT NULL,
      "entity_type" varchar NOT NULL,
      "entity_id" varchar NOT NULL,
      "canonical_state" jsonb NOT NULL CHECK (jsonb_typeof("canonical_state") = 'object'),
      "reconciliation_case_id" varchar,
      "supersedes_revision_id" varchar REFERENCES "nex_canonical_projection_revisions"("projection_revision_id"),
      "materialized_at" timestamp(3) with time zone NOT NULL,
      "explanation" text NOT NULL CHECK (length(trim("explanation")) > 0)
    );

    CREATE INDEX IF NOT EXISTS "nex_proj_subject_idx" ON "nex_canonical_projection_revisions" USING btree ("domain", "entity_type", "entity_id");
    CREATE INDEX IF NOT EXISTS "nex_proj_materialized_at_idx" ON "nex_canonical_projection_revisions" USING btree ("materialized_at");

    -- 10. CANONICAL PROJECTION OBSERVATIONS
    CREATE TABLE IF NOT EXISTS "nex_canonical_projection_observations" (
      "projection_revision_id" varchar NOT NULL REFERENCES "nex_canonical_projection_revisions"("projection_revision_id") ON DELETE CASCADE,
      "observation_id" varchar NOT NULL REFERENCES "nex_observation_records"("observation_id"),
      PRIMARY KEY ("projection_revision_id", "observation_id")
    );

    -- 11. CANONICAL PROJECTION REVIEWS
    CREATE TABLE IF NOT EXISTS "nex_canonical_projection_reviews" (
      "projection_revision_id" varchar NOT NULL REFERENCES "nex_canonical_projection_revisions"("projection_revision_id") ON DELETE CASCADE,
      "review_id" varchar NOT NULL REFERENCES "nex_review_events"("review_id"),
      PRIMARY KEY ("projection_revision_id", "review_id")
    );

    -- 12. CANONICAL PROJECTION HEADS (Ponteiro Operacional Mutável)
    CREATE TABLE IF NOT EXISTS "nex_canonical_projection_heads" (
      "domain" varchar NOT NULL,
      "entity_type" varchar NOT NULL,
      "entity_id" varchar NOT NULL,
      "current_projection_revision_id" varchar NOT NULL REFERENCES "nex_canonical_projection_revisions"("projection_revision_id"),
      "version" bigint DEFAULT 1 NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("domain", "entity_type", "entity_id")
    );
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "nex_canonical_projection_heads";
    DROP TABLE IF EXISTS "nex_canonical_projection_reviews";
    DROP TABLE IF EXISTS "nex_canonical_projection_observations";
    DROP TABLE IF EXISTS "nex_canonical_projection_revisions";
    DROP TABLE IF EXISTS "nex_review_event_evidence";
    DROP TABLE IF EXISTS "nex_review_event_previous_reviews";
    DROP TABLE IF EXISTS "nex_review_event_observations";
    DROP TABLE IF EXISTS "nex_review_events";
    DROP TABLE IF EXISTS "nex_observation_ingest_keys";
    DROP TABLE IF EXISTS "nex_observation_evidence_refs";
    DROP TABLE IF EXISTS "nex_observation_sources";
    DROP TABLE IF EXISTS "nex_observation_records";
  `);
}
