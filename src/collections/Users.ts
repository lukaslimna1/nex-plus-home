import type { Access, CollectionConfig } from 'payload';
import { getEdgeServerConfig } from '../auth/edge-config';

const isAdmin: Access = ({ req: { user } }) => Boolean(user?.collection === 'admins');
const edgeConfig = getEdgeServerConfig();

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
    cookies: edgeConfig.cookies,
    // Workaround deliberado para Payload 3.88.0:
    // @payloadcms/next/auth login() depende de result.token para materializar o cookie HTTP-only.
    // Quando removeTokenFromResponses é true na 3.88.0, o token é removido antes do helper Next criar o cookie.
    // Omitir removeTokenFromResponses mantém o valor padrão (false) para que o cookie seja criado com sucesso.
    // Nossa Server Action (src/auth/actions.ts) nunca repassa o token para o frontend.
    // Revisar quando uma versão estável futura incorporar o fix upstream (commit b292343).
  },
  fields: [
    {
      name: 'displayName',
      type: 'text',
      required: true,
    },
  ],
};
