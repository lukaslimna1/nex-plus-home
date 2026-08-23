/**
 * NEX+ · Template de E-mail para Redefinição de Senha
 * Design alinhado à identidade visual Dark Glass / Arkana do NEX+.
 */

export interface ResetPasswordEmailData {
  readonly resetUrl: string;
  readonly recipientEmail: string;
  readonly displayName?: string;
}

export function generateResetPasswordEmailHtml(data: ResetPasswordEmailData): string {
  const greeting = data.displayName ? `Olá, ${escapeHtml(data.displayName)}.` : 'Olá.';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NEX+ · Redefinição de senha</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #07070e;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #f8fafc;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #07070e;
      padding: 40px 16px;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      background-color: #0c0d18;
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 20px;
      padding: 36px 32px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
    }
    .brand {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #ffffff;
      margin-bottom: 6px;
    }
    .brand span {
      color: #f43f5e;
    }
    .tagline {
      font-size: 13px;
      color: #94a3b8;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 24px;
    }
    .divider {
      height: 2px;
      background: linear-gradient(90deg, #ec4899 0%, #f97316 100%);
      margin-bottom: 28px;
      border-radius: 2px;
    }
    .title {
      font-size: 19px;
      font-weight: 700;
      color: #ffffff;
      margin: 0 0 14px 0;
    }
    .text {
      font-size: 15px;
      line-height: 1.6;
      color: #cbd5e1;
      margin: 0 0 24px 0;
    }
    .btn-container {
      text-align: center;
      margin: 32px 0;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(90deg, #4f46e5 0%, #9333ea 50%, #db2777 100%);
      color: #ffffff !important;
      text-decoration: none;
      font-size: 15px;
      font-weight: 600;
      padding: 14px 32px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(147, 51, 234, 0.4);
    }
    .link-fallback {
      font-size: 12px;
      color: #64748b;
      word-break: break-all;
      line-height: 1.5;
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .link-fallback a {
      color: #818cf8;
      text-decoration: underline;
    }
    .footer {
      margin-top: 28px;
      font-size: 12px;
      color: #64748b;
      text-align: center;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="brand">NEX<span>+</span></div>
      <div class="tagline">Sistema Operacional Inteligente</div>
      <div class="divider"></div>

      <h1 class="title">Recuperação de Senha</h1>
      <p class="text">${greeting}</p>
      <p class="text">Recebemos uma solicitação para redefinir a senha da sua conta no NEX+. Clique no botão abaixo para criar uma nova senha:</p>

      <div class="btn-container">
        <a href="${escapeHtml(data.resetUrl)}" class="btn" target="_blank" rel="noopener noreferrer">Redefinir Minha Senha</a>
      </div>

      <p class="text" style="font-size: 13px; color: #94a3b8;">
        Este link é válido por <strong>1 hora</strong> e só pode ser utilizado uma única vez.
      </p>

      <div class="link-fallback">
        Se o botão não funcionar, copie e cole o seguinte link no seu navegador:<br>
        <a href="${escapeHtml(data.resetUrl)}">${escapeHtml(data.resetUrl)}</a>
      </div>

      <div class="footer">
        Se você não solicitou a alteração de senha, ignore este e-mail com segurança.<br>
        Nenhuma alteração foi realizada na sua conta.
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function generateResetPasswordEmailText(data: ResetPasswordEmailData): string {
  const greeting = data.displayName ? `Olá, ${data.displayName}.` : 'Olá.';

  return `NEX+ · Sistema Operacional Inteligente
==================================================

Recuperação de Senha

${greeting}

Recebemos uma solicitação para redefinir a senha da sua conta no NEX+.
Para criar uma nova senha, acesse o link abaixo:

${data.resetUrl}

Este link é válido por 1 hora e só pode ser utilizado uma única vez.

Se você não solicitou a alteração de senha, ignore este e-mail com segurança.
Nenhuma alteração foi realizada na sua conta.
`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
