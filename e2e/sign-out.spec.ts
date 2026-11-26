import { expect, test } from '@playwright/test';
import { ROLE_SEED_ACTORS, storageStatePathFor } from './global-setup';

function findActor(stateKey: string) {
  const actor = ROLE_SEED_ACTORS.find((a) => a.stateKey === stateKey);
  if (!actor) {
    throw new Error(`Missing ROLE_SEED_ACTORS entry for ${stateKey}`);
  }
  return actor;
}

test.describe('Sign-out flow (D22)', () => {
  test('signing out from the account menu clears the session and blocks protected routes', async ({
    browser,
  }) => {
    const actor = findActor('fee_earner');
    const context = await browser.newContext({
      storageState: storageStatePathFor(actor.stateKey),
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const consoleWarnings: string[] = [];

    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'error') {
        consoleWarnings.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    try {
      await page.goto('/');
      await expect(page.locator('.hero-greeting')).toContainText(actor.firstName);

      await page.locator('button.avatar-btn').click();

      const signOutButton = page.locator(
        'form[action="/api/auth/logout"] button[type="submit"]',
      );
      await expect(signOutButton).toBeVisible();
      await expect(signOutButton).toHaveText(`Sign out (${actor.email})`);

      await signOutButton.click();

      await expect(page).toHaveURL(/\/\?signedOut=1$/, { timeout: 10_000 });
      await expect(
        page.getByRole('heading', { name: 'Sign in to 1Squared' }),
      ).toBeVisible();
      await expect(
        page.getByRole('status').filter({
          hasText: 'You have been signed out of 1Squared.',
        }),
      ).toBeVisible();
      expect(
        (await context.cookies()).some(
          (c) => c.name === 'onesquared_entra_session',
        ),
      ).toBe(false);

      await page.goto('/matters');
      await expect(
        page.getByRole('heading', { name: 'Sign in to 1Squared' }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Sign in with Microsoft' }),
      ).toHaveAttribute('href', '/api/auth/login?returnTo=%2Fmatters');
      await expect(page.locator('.app-shell')).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    } catch (err) {
      if (consoleWarnings.length > 0) {
        console.log('Captured browser console warnings/errors:', consoleWarnings);
      }
      throw err;
    } finally {
      await context.close();
    }
  });
});
