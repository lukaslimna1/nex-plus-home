import { postgresAdapter } from '@payloadcms/db-postgres'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'

import { Admins } from './collections/Admins'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

function getRequiredEnv(name: string): string {
  const val = process.env[name]
  if (!val || val.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return val
}

export default buildConfig({
  admin: {
    user: Admins.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Admins],
  secret: getRequiredEnv('PAYLOAD_SECRET'),
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: getRequiredEnv('DATABASE_URL'),
    },
    disableCreateDatabase: true,
    idType: 'uuid',
  }),
})
