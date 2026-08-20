import { test, expect } from '@playwright/test';
import { getPayload } from 'payload';
import configPromise from '../../src/payload.config';
import crypto from 'node:crypto';

test.describe('NEX+ Multiusuário · E2E Authentication Flow (0.8A Hardening)', () => {
  let testUserId: string;
  const testEmail = `e2e-${Date.now()}@nex-test.invalid`;
  const testPassword = `E2E_${crypto.randomBytes(16).toString('hex')}!Aa1`;
  const testDisplayName = 'Sócio E2E Teste';

  test.beforeAll(async () => {
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

  test('E8. Login com senha inválida permanece em /login e exibe mensagem genérica', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', 'wrong-password-123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login/);
    const errorAlert = page.getByRole('alert').filter({ hasText: 'E-mail ou senha inválidos.' });
    await expect(errorAlert).toBeVisible();
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

  test('E9-E11. Logout a partir do UserMiniCard invalida a sessão e redireciona para /login', async ({ page, context }) => {
    // 1. Logar primeiro
    await page.goto('/login');
    await page.fill('input#email', testEmail);
    await page.fill('input#password', testPassword);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/home/);

    // 2. Abrir UserMiniCard e clicar em Sair
    const userCard = page.locator(`button[title*="${testDisplayName}"]`);
    await userCard.click();

    const logoutButton = page.locator('button:has-text("Sair")');
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    // E9. Redireciona para /login
    await expect(page).toHaveURL(/\/login/);

    // E11. Acessar /home após logout deve redirecionar para /login
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login/);
  });
});
