import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- NEX+ · Canonical Job Claims & Operational Lease
    -- Checkpoint 0.86C-3B: Autoridade Operacional NEX de Claim, Lease, Expiry, Renew, Release e Fencing
    CREATE TABLE IF NOT EXISTS "nex_job_claims" (
      "job_id" varchar PRIMARY KEY NOT NULL REFERENCES "nex_job_heads"("job_id") ON DELETE RESTRICT,
      "worker_id" varchar NOT NULL,
      "fencing_token" bigint NOT NULL,
      "acquired_at" timestamp(3) with time zone NOT NULL,
      "renewed_at" timestamp(3) with time zone NOT NULL,
      "lease_until" timestamp(3) with time zone NOT NULL,
      "released_at" timestamp(3) with time zone,
      CONSTRAINT "nex_job_claims_fencing_token_chk" CHECK ("fencing_token" >= 1)
    );

    CREATE INDEX IF NOT EXISTS "nex_job_claims_worker_id_idx" ON "nex_job_claims" USING btree ("worker_id");
    CREATE INDEX IF NOT EXISTS "nex_job_claims_lease_until_idx" ON "nex_job_claims" USING btree ("lease_until");
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "nex_job_claims";
  `);
}
