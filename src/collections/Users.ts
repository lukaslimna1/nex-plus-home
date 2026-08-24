import type { Access, CollectionConfig } from 'payload';
import { getEdgeServerConfig } from '../auth/edge-config';
import {
  generateResetPasswordEmailHtml,
} from '../email/templates/reset-password-email';

const isAdmin: Access = ({ req: { user } }) => Boolean(user?.collection === 'admins');
const isSelfOrAdmin: Access = ({ req: { user }, id }) => {
  if (!user) return true;
  if (user.collection === 'admins') return true;
  return user.id === id;
};
const edgeConfig = getEdgeServerConfig();

export const Users: CollectionConfig = {
  slug: 'users',
  access: {
    admin: ({ req: { user } }) => Boolean(user?.collection === 'admins'),
    create: isAdmin,
    read: isSelfOrAdmin,
    update: isSelfOrAdmin,
    delete: isAdmin,
    unlock: isAdmin,
  },
  admin: {
    useAsTitle: 'displayName',
    defaultColumns: ['displayName', 'email', 'createdAt'],
  },
  auth: {
    useSessions: true,
    tokenExpiration: Number(process.env.NEX_AUTH_TOKEN_EXPIRATION_SECONDS) || 620, // 620s = 10m20s (Sliding Session ancorada na inatividade canônica de 600s + 10s grace + 10s safety buffer)
    cookies: edgeConfig.cookies,
    forgotPassword: {
      expiration: 3600000, // 1 hora
      generateEmailSubject: () => 'NEX+ · Redefinição de senha',
      generateEmailHTML: (args) => {
        const token = args?.token || '';
        const user = args?.user;
        const serverUrl = process.env.PAYLOAD_PUBLIC_SERVER_URL || 'https://nex.starlevel.com.br';
        const resetUrl = `${serverUrl}/reset-password?token=${token}`;
        return generateResetPasswordEmailHtml({
          resetUrl,
          recipientEmail: user?.email || '',
          displayName: typeof user?.displayName === 'string' ? user.displayName : undefined,
        });
      },
    },
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
    {
      name: 'sessions',
      type: 'array',
      access: {
        read: () => true,
        update: () => true,
      },
      admin: {
        disabled: true,
      },
      fields: [
        {
          name: 'id',
          type: 'text',
          required: true,
        },
        {
          name: 'createdAt',
          type: 'date',
        },
        {
          name: 'expiresAt',
          type: 'date',
          required: true,
        },
      ],
    },
  ],
};
