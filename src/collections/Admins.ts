import type { Access, CollectionConfig } from 'payload'
import { getEdgeServerConfig } from '../auth/edge-config'

const isAdmin: Access = ({ req: { user } }) => Boolean(user?.collection === 'admins')
const edgeConfig = getEdgeServerConfig()

export const Admins: CollectionConfig = {
  slug: 'admins',
  access: {
    admin: ({ req: { user } }) => Boolean(user?.collection === 'admins'),
    create: isAdmin,
    read: isAdmin,
    update: isAdmin,
    delete: isAdmin,
    unlock: isAdmin,
  },
  admin: {
    useAsTitle: 'email',
  },
  auth: {
    cookies: edgeConfig.cookies,
  },
  fields: [
    // Email added by default
    // Add more fields as needed
  ],
}
