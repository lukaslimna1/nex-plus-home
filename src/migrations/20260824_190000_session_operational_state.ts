import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- 1. SESSION OPERATIONAL STATE (Estado Mínimo da Sessão por SessionRef)
    CREATE TABLE IF NOT EXISTS "nex_session_operational_state" (
      "session_ref" varchar PRIMARY KEY NOT NULL,
      "user_id" varchar NOT NULL,
      "subject_type" varchar,
      "subject_id" varchar,
      "revision" integer DEFAULT 1 NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "nex_sess_op_state_session_ref_chk" CHECK ("session_ref" ~ '^[a-f0-9]{64}$'),
      CONSTRAINT "nex_sess_op_state_user_id_chk" CHECK (length(trim("user_id")) > 0),
      CONSTRAINT "nex_sess_op_state_revision_chk" CHECK ("revision" >= 1),
      CONSTRAINT "nex_sess_op_state_subject_pair_chk" CHECK (
        ("subject_type" IS NULL AND "subject_id" IS NULL) OR
        ("subject_type" IS NOT NULL AND "subject_id" IS NOT NULL AND length(trim("subject_type")) > 0 AND length(trim("subject_id")) > 0)
      )
    );

    CREATE INDEX IF NOT EXISTS "nex_sess_op_state_user_id_idx" ON "nex_session_operational_state" USING btree ("user_id");
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "nex_session_operational_state";
  `);
}
