import { postgresAdapter } from '@payloadcms/db-postgres'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'

import { Admins } from './collections/Admins'
import { Users } from './collections/Users'
import { getEdgeServerConfig } from './auth/edge-config'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

function getRequiredEnv(name: string): string {
  const val = process.env[name]
  if (!val || val.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return val
}

const edgeConfig = getEdgeServerConfig()

export default buildConfig({
  admin: {
    user: Admins.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Admins, Users],
  secret: getRequiredEnv('PAYLOAD_SECRET'),
  ...(edgeConfig.serverURL ? { serverURL: edgeConfig.serverURL } : {}),
  ...(edgeConfig.csrf ? { csrf: edgeConfig.csrf } : {}),
  ...(edgeConfig.cors ? { cors: edgeConfig.cors } : {}),
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  graphQL: {
    disable: true,
  },
  db: postgresAdapter({
    pool: {
      connectionString: getRequiredEnv('DATABASE_URL'),
    },
    disableCreateDatabase: true,
    idType: 'uuid',
  }),
})
