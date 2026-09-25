import type { Access, CollectionConfig } from 'payload';
import { getEdgeServerConfig } from '../auth/edge-config';
import {
  generateResetPasswordEmailHtml,
} from '../email/templates/reset-password-email';

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
    // Workaround preservado para Payload 3.90.2:
    // O helper @payloadcms/next/auth na versão 3.90.2 aparentemente já materializa o cookie antes de remover result.token.
    // Contudo, a remoção do workaround/hardening e habilitação de removeTokenFromResponses será avaliada em checkpoint separado.
    // Esta rodada de manutenção de stack não mistura upgrade com simplificação de Auth; removeTokenFromResponses permanece false por padrão.
    // Nossa Server Action (src/auth/actions.ts) continua nunca repassando o token para o frontend.
  },
  fields: [
    {
      name: 'displayName',
      type: 'text',
      required: true,
    },
  ],
};
