import type { Access, CollectionConfig } from 'payload';

const isAdmin: Access = ({ req: { user } }) => Boolean(user?.collection === 'admins');

export const Users: CollectionConfig = {
  slug: 'users',
  access: {
    admin: ({ req: { user } }) => Boolean(user?.collection === 'admins'),
    create: isAdmin,
    read: isAdmin,
    update: isAdmin,
    delete: isAdmin,
    unlock: isAdmin,
  },
  admin: {
    useAsTitle: 'displayName',
    defaultColumns: ['displayName', 'email', 'createdAt'],
  },
  auth: {
    useSessions: true,
    removeTokenFromResponses: true,
  },
  fields: [
    {
      name: 'displayName',
      type: 'text',
      required: true,
    },
  ],
};
