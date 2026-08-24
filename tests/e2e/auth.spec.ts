import { test, expect } from '@playwright/test';
import { getPayload } from 'payload';
import configPromise from '../../src/payload.config';
import crypto from 'node:crypto';

test.describe('NEX+ Multiusuário · E2E Authentication Flow (0.8A Isolated Harness)', () => {
  let testUserId: string;
  const testEmail = `e2e-${Date.now()}@nex-test.invalid`;
  const testPassword = `E2E_${crypto.randomBytes(16).toString('hex')}!Aa1`;
  let currentTestPassword = testPassword;
  const testDisplayName = 'Sócio E2E Teste';

  test.beforeAll(async () => {
    // 1. Trava de segurança obrigatória contra banco operacional
    const dbUrl = process.env.DATABASE_URL || '';
    const isIsolated = process.env.NEX_E2E_ISOLATED === '1';
    const dbNameMatch = dbUrl.match(/\/([^/?]+)(?:\?|$)/);
    const dbName = dbNameMatch ? dbNameMatch[1] : '';

    if (!isIsolated || !dbName.startsWith('nex_e2e_')) {
      throw new Error(
        `[SECURITY_GUARD] E2E recusou execução: banco '${dbName}' não é descartável. Exigido prefixo 'nex_e2e_' e NEX_E2E_ISOLATED=1.`,
      );
    }

    // 2. Setup administrativo controlado na base descartável
    const payload = await getPayload({ config: configPromise });
    const userDoc = await payload.create({
      collection: 'users',
      data: {
        email: testEmail,
        password: testPassword,
        displayName: testDisplayName,
      },
    });
    testUserId = userDoc.id;
  });

  test.afterAll(async () => {
    if (testUserId) {
      const payload = await getPayload({ config: configPromise });
      await payload.delete({
        collection: 'users',
        id: testUserId,
      }).catch(() => {});
    }
  });

  test('E1. /login anônimo retorna 200 e exibe o formulário de login', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.status()).toBe(200);
    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('input#password')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('E2. /home anônimo redireciona com segurança para /login', async ({ page }) => {
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login/);
  });

  test('E3. / anônimo redireciona para /home e termina em /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('E8. Login com senha inválida permanece em /login, exibe mensagem genérica e não emite cookie', async ({ page, context }) => {
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', 'wrong-password-123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login/);
    const errorAlert = page.getByRole('alert').filter({ hasText: 'E-mail ou senha inválidos.' });
    await expect(errorAlert).toBeVisible();

    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name === 'payload-token');
    expect(authCookie).toBeUndefined();
  });

  test('E4-E7. Login real via interface acessa /home, projeta displayName e persiste sessão no reload', async ({ page, context }) => {
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', testPassword);
    await page.click('button[type="submit"]');

    // E4. URL final é /home
    await expect(page).toHaveURL(/\/home/);

    // E5. DisplayName real aparece na Sidebar
    const userCard = page.locator(`button[title*="${testDisplayName}"]`);
    await expect(userCard).toBeVisible();
    await expect(page.locator(`text=${testDisplayName}`)).toBeVisible();

    // E6. Cookie de autenticação HTTP-only foi emitido
    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name === 'payload-token');
    expect(authCookie).toBeDefined();
    expect(authCookie?.httpOnly).toBe(true);

    // E7. Reload continua autenticado na /home
    await page.reload();
    await expect(page).toHaveURL(/\/home/);
    await expect(page.locator(`text=${testDisplayName}`)).toBeVisible();
  });

  test('E9-E11. Logout invalida a sessão no servidor, remove o cookie e rejeita reuso de cookie antigo', async ({ page, context }) => {
    // 1. Logar primeiro
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', testPassword);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/home/);

    // 2. Capturar em memória o cookie válido antes do logout
    const cookiesBefore = await context.cookies();
    const oldAuthCookie = cookiesBefore.find((c) => c.name === 'payload-token');
    expect(oldAuthCookie).toBeDefined();

    // 3. Abrir UserMiniCard e clicar em Sair
    const userCard = page.locator(`button[title*="${testDisplayName}"]`);
    await userCard.click();

    const logoutButton = page.locator('button:has-text("Sair")');
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    // E9. Redireciona para /login
    await expect(page).toHaveURL(/\/login/);

    // E10. Cookie foi removido do contexto do navegador
    const cookiesAfter = await context.cookies();
    const authCookieAfter = cookiesAfter.find((c) => c.name === 'payload-token');
    expect(authCookieAfter).toBeUndefined();

    // E11. Acessar /home após logout deve redirecionar para /login
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login/);

    // E12. Re-injetar cookie antigo capturado: prova que a sessão no banco users_sessions foi revogada
    if (oldAuthCookie) {
      await context.addCookies([oldAuthCookie]);
      await page.goto('/home');
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test('E13. /login contém link para /forgot-password e /forgot-password renderiza corretamente', async ({ page }) => {
    await page.goto('/login');
    const forgotLink = page.locator('a:has-text("Esqueci minha senha?")');
    await expect(forgotLink).toBeVisible();
    await expect(forgotLink).toHaveAttribute('href', '/forgot-password');

    await forgotLink.click();
    await expect(page).toHaveURL(/\/forgot-password/);
    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('E14. /forgot-password com e-mail inexistente exibe mensagem neutra sem vazar conta', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.fill('input#email', 'naoexiste@nex-test.invalid');
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Solicitação Enviada')).toBeVisible();
    await expect(page.locator('text=Se existir uma conta associada')).toBeVisible();
  });

  test('E15-E17. Ciclo completo: forgot-password -> reset-password -> token consumido -> login com nova senha', async ({ page }) => {
    const payload = await getPayload({ config: configPromise });

    // 1. Solicitar recuperação para o usuário existente
    await page.goto('/forgot-password');
    await page.fill('input#email', testEmail);
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Solicitação Enviada')).toBeVisible();

    // 2. Obter token gerado pelo Payload no banco descartável
    const userInDb = await payload.findByID({
      collection: 'users',
      id: testUserId,
      overrideAccess: true,
      showHiddenFields: true,
    });

    const resetToken = (userInDb as any).resetPasswordToken;
    expect(resetToken).toBeDefined();
    expect(typeof resetToken).toBe('string');
    expect(resetToken.length).toBeGreaterThan(10);

    // 3. Acessar /reset-password com token inválido/vazio
    await page.goto('/reset-password');
    await expect(page.locator('text=Link Inválido')).toBeVisible();

    // 4. Acessar /reset-password com token válido
    await page.goto(`/reset-password?token=${resetToken}`);
    await expect(page.locator('input#password')).toBeVisible();
    await expect(page.locator('input#confirmPassword')).toBeVisible();

    // 5. Redefinir senha com sucesso
    const newPassword = `New_${crypto.randomBytes(16).toString('hex')}!Aa1`;
    currentTestPassword = newPassword;
    await page.fill('input#password', newPassword);
    await page.fill('input#confirmPassword', newPassword);
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Senha Alterada')).toBeVisible();

    // 6. Testar anti-reuso: Acessar novamente a mesma URL com o token já consumido
    await page.goto(`/reset-password?token=${resetToken}`);
    await page.fill('input#password', 'AnotherPass123!');
    await page.fill('input#confirmPassword', 'AnotherPass123!');
    await page.click('button[type="submit"]');

    const resetAlert = page.getByRole('alert').filter({ hasText: 'inválido ou já expirou' });
    await expect(resetAlert).toBeVisible();

    // 7. Login com a senha antiga falha
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', testPassword);
    await page.click('button[type="submit"]');
    const loginAlert = page.getByRole('alert').filter({ hasText: 'E-mail ou senha inválidos.' });
    await expect(loginAlert).toBeVisible();

    // 8. Login com a nova senha tem sucesso e entra em /home
    await page.fill('input#password', currentTestPassword);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/home/);
    await expect(page.locator(`text=${testDisplayName}`)).toBeVisible();
  });

  test('E18. Sincronização multi-aba: comando de logout emitido em uma aba redireciona as demais para /login', async ({ page }) => {
    // 1. Logar na aplicação com a senha atual
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', currentTestPassword);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/home/);

    // 2. Disparar mensagem de LOGOUT via BroadcastChannel (como se fosse de outra aba)
    await page.evaluate(() => {
      const channel = new BroadcastChannel('nex_auth_activity');
      channel.postMessage({ type: 'LOGOUT', timestamp: Date.now(), reason: 'other_tab_logout' });
    });

    // 3. A página deve detectar a mensagem e redirecionar imediatamente para /login
    await expect(page).toHaveURL(/\/login/);
  });
});
