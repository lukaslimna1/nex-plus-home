/**
 * NEX+ · Google Apps Script Email Adapter
 * Fase 0 — Zero-Cost Transactional Email Transport para Payload 3.88
 *
 * Implementa a interface nativa EmailAdapter do Payload delegando o envio para
 * o Web App do Google Apps Script (MailApp).
 */

import type { EmailAdapter, SendEmailOptions } from 'payload';

export interface GoogleAppsScriptEmailAdapterArgs {
  defaultFromAddress?: string;
  defaultFromName?: string;
  relayUrl?: string;
  relaySecret?: string;
}

export interface SentEmailRecord {
  to: string | string[];
  subject?: string;
  html?: string;
  text?: string;
  fromName?: string;
  timestamp: string;
}

/**
 * Buffer em memória para inspeção e validação em testes locais / suítes automatizadas.
 */
export const emailTestBuffer: SentEmailRecord[] = [];

export function clearEmailTestBuffer(): void {
  emailTestBuffer.length = 0;
}

export const googleAppsScriptEmailAdapter = (
  args?: GoogleAppsScriptEmailAdapterArgs,
): EmailAdapter => {
  const defaultFromAddress = args?.defaultFromAddress || 'noreply@starlevel.com.br';
  const defaultFromName = args?.defaultFromName || 'NEX+';

  return ({ payload }) => {
    return {
      name: 'google-apps-script',
      defaultFromAddress,
      defaultFromName,
      sendEmail: async (message: SendEmailOptions) => {
        const relayUrl = args?.relayUrl || process.env.NEX_EMAIL_RELAY_URL;
        const relaySecret = args?.relaySecret || process.env.NEX_EMAIL_RELAY_SECRET;

        const to = message.to as string | string[];
        const subject = message.subject || 'Notificação NEX+';
        const html = typeof message.html === 'string' ? message.html : undefined;
        const text = typeof message.text === 'string' ? message.text : undefined;

        // Registrar no buffer para testes
        emailTestBuffer.push({
          to,
          subject,
          html,
          text,
          fromName: defaultFromName,
          timestamp: new Date().toISOString(),
        });

        // Modo Real: Quando URL e Secret do Google Apps Script estiverem configurados
        if (relayUrl && relaySecret) {
          try {
            const response = await fetch(relayUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                secret: relaySecret,
                to,
                subject,
                html,
                text,
                fromName: defaultFromName,
              }),
            });

            if (!response.ok) {
              payload.logger.error({
                msg: `[NEX Email Relay] HTTP ${response.status} ao conectar no relay`,
              });
              throw new Error(`Email relay returned status ${response.status}`);
            }

            const data = (await response.json().catch(() => ({ success: true }))) as { success?: boolean; error?: string };
            if (data && data.success === false) {
              payload.logger.error({
                msg: `[NEX Email Relay] Falha informada pelo relay`,
              });
              throw new Error(`Email relay reported failure`);
            }

            payload.logger.info({
              msg: `[NEX Email Relay] Email transacional despachado com sucesso via Google Apps Script`,
            });

            return;
          } catch (relayError: unknown) {
            payload.logger.error({
              msg: `[NEX Email Relay] Exceção ao conectar no relay Google Apps Script`,
            });
            throw relayError;
          }
        }

        // Modo Local/Dev/Fallback quando o relay remoto não está conectado
        if (process.env.NODE_ENV === 'production') {
          payload.logger.warn({
            msg: `[NEX Email Relay] AVISO OPERACIONAL: NEX_EMAIL_RELAY_URL ou NEX_EMAIL_RELAY_SECRET não configurados em ambiente de produção. E-mail retido no buffer local.`,
          });
        } else {
          payload.logger.info({
            msg: `[NEX Email Relay (Local/Mock)] Mensagem retida no buffer de testes`,
          });
        }
      },
    };
  };
};
