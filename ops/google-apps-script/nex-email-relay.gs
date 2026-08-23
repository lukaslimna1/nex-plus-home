/**
 * NEX+ · Google Apps Script Email Relay
 * Fase 0 — Zero-Cost Transactional Email Transport
 *
 * Web App script para envio de e-mails transacionais (ex: recuperação de senha)
 * via Google Apps Script (MailApp).
 *
 * Instruções de Deploy:
 * 1. Abra https://script.google.com e crie um novo projeto com o nome "NEX-Email-Relay".
 * 2. Cole este código no arquivo Código.gs.
 * 3. Acesse Configurações do Projeto > Propriedades do script e adicione:
 *    - NEX_EMAIL_RELAY_SECRET = [seu segredo gerado com openssl rand -hex 32]
 * 4. Clique em Implantar > Nova Implantação:
 *    - Tipo: Aplicativo da Web
 *    - Executar como: Eu (sua conta Google)
 *    - Quem tem acesso: Qualquer pessoa
 * 5. Copie a URL do Web App gerada e configure em NEX_EMAIL_RELAY_URL no .env do servidor NEX+.
 */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ success: false, error: 'Empty request body' }, 400);
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseError) {
      return createJsonResponse({ success: false, error: 'Invalid JSON payload' }, 400);
    }

    var scriptProperties = PropertiesService.getScriptProperties();
    var configuredSecret = scriptProperties.getProperty('NEX_EMAIL_RELAY_SECRET');

    if (!configuredSecret) {
      return createJsonResponse({ success: false, error: 'Relay secret not configured' }, 500);
    }

    if (!payload.secret || payload.secret !== configuredSecret) {
      return createJsonResponse({ success: false, error: 'Unauthorized' }, 401);
    }

    if (!payload.to || !payload.subject || (!payload.html && !payload.text)) {
      return createJsonResponse({ success: false, error: 'Missing required email fields (to, subject, html/text)' }, 400);
    }

    var toAddress = Array.isArray(payload.to) ? payload.to.join(',') : String(payload.to);
    var fromName = payload.fromName || 'NEX+';
    var plainBody = payload.text || (payload.html ? payload.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');

    var emailOptions = {
      to: toAddress,
      subject: payload.subject,
      name: fromName,
      body: plainBody
    };

    if (payload.html) {
      emailOptions.htmlBody = payload.html;
    }

    MailApp.sendEmail(emailOptions);

    return createJsonResponse({ success: true });
  } catch (error) {
    // Retorno seguro sem vazar stack traces internos
    return createJsonResponse({ success: false, error: 'Failed to send email through MailApp' }, 500);
  }
}

function doGet(e) {
  return createJsonResponse({
    status: 'NEX+ Email Relay Active',
    timestamp: new Date().toISOString()
  }, 200);
}

function createJsonResponse(data, statusCode) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
