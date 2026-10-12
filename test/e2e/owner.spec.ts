import { test, expect } from '@playwright/test';
import { login, photo, resetLoginLimits, answer, progress } from './helpers.ts';

test.beforeEach(async ({ request }) => {
  await resetLoginLimits(request);
});

test('owner login rejects a wrong password', async ({ page }) => {
  await login(page, 'not-the-password');
  await expect(page.getByRole('alert')).toHaveText('Incorrect password.');
  await expect(page.getByRole('button', { name: /sign in/i })).toBeEnabled();
  expect((await page.request.get('/api/owner/games')).status()).toBe(401);
});

test('owner creates, uploads, publishes; a guest plays the invite', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Make them look twice.' })).toBeVisible();

  // The server is shared across tests, so the studio may already list other games.
  const title = `E2E weekend test ${test.info().project.name} ${Date.now()}`;
  await page.getByLabel('Give your game a name').fill(title);
  await page.getByRole('button', { name: /create draft/i }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('button', { name: /publish/i })).toBeDisabled();

  await page
    .getByLabel('Upload photos')
    .setInputFiles([await photo('one.png', 30, 160, 90), await photo('two.png', 90, 40, 200)]);
  await expect(page.getByText('2 / 10 questions')).toBeVisible();
  // The studio polls every three seconds while the fake models process the uploads.
  await expect(page.getByText('Ready to play')).toHaveCount(2, { timeout: 20000 });
  await expect(page.getByRole('img', { name: 'Uploaded photo 1' })).toBeVisible();

  const publish = page.getByRole('button', { name: /publish/i });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByText('Your invite is ready')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  const href = await page.getByRole('link', { name: /\/g\// }).getAttribute('href');
  expect(href).toMatch(/^\/g\/[\w-]+$/);
  const invite = href!.split('/')[2];

  // Guests have no owner session: drop the cookie but keep the project's device settings.
  await page.context().clearCookies();
  const guest = page;
  await guest.goto(href!);
  await expect(guest.getByRole('heading', { name: title })).toBeVisible();
  await expect(guest.getByText('2 questions')).toBeVisible();
  await guest.getByRole('button', { name: /let.s play/i }).click();
  await progress(guest, 1, 2);
  await answer(guest, invite, true);
  await guest.getByRole('button', { name: /next/i }).click();
  await progress(guest, 2, 2);
  await answer(guest, invite, false);
  await guest.getByRole('button', { name: /see my score/i }).click();
  await expect(guest.getByText('Correct answers out of 2 questions.')).toBeVisible();
  await expect(guest.getByText('1 / 2', { exact: true })).toBeVisible();
  expect((await guest.request.get('/api/owner/games')).status()).toBe(401);
});
