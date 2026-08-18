import type { Access, CollectionConfig } from 'payload'

const isAdmin: Access = ({ req: { user } }) => Boolean(user?.collection === 'admins')

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
  auth: true,
  fields: [
    // Email added by default
    // Add more fields as needed
  ],
}
