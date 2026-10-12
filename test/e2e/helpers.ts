import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import sharp from 'sharp';

export const PASSWORD = process.env.E2E_OWNER_PASSWORD || 'e2e-owner-password';

export type AnswerKey = {
  current: number;
  questions: { id: string; ai: number; chosen: number | null }[];
};

// Published game with ready questions, created through the e2e server's test controls.
export async function seedGame(request: APIRequestContext, questions = 2, title = 'Seeded game') {
  const res = await request.post('/__e2e/seed', { data: { questions, title } });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: string; invite: string };
}
export async function expireGame(request: APIRequestContext, invite: string, purge = false) {
  expect((await request.post('/__e2e/expire', { data: { invite, purge } })).ok()).toBe(true);
}
export async function resetLoginLimits(request: APIRequestContext) {
  expect((await request.post('/__e2e/reset-login-limits')).ok()).toBe(true);
}
export async function playId(page: Page, invite: string) {
  const id = await page.evaluate((key) => localStorage.getItem(key), 'slop:' + invite);
  expect(id).toBeTruthy();
  return id!;
}
export async function answerKey(page: Page, invite: string): Promise<AnswerKey> {
  const res = await page.request.get('/__e2e/plays/' + (await playId(page, invite)));
  expect(res.ok()).toBe(true);
  return res.json();
}
export const choice = (page: Page, side: number) =>
  page.getByRole('button', { name: `Choose image ${side ? 'B' : 'A'} as AI-generated` });
// Question badge, e.g. "2 / 3". The score summary uses the same format, so require the question.
export async function progress(page: Page, current: number, total: number) {
  await expect(page.getByRole('heading', { name: 'Which one is slop?' })).toBeVisible();
  await expect(page.getByText(`${current} / ${total}`, { exact: true })).toBeVisible();
}

export async function startInvite(page: Page, invite: string) {
  await page.goto('/g/' + invite);
  await page.getByRole('button', { name: /let.s play/i }).click();
  await expect(page.getByRole('heading', { name: 'Which one is slop?' })).toBeVisible();
}
// Answers the current question correctly (or not), using the server-side answer key.
export async function answer(page: Page, invite: string, correct: boolean) {
  const key = await answerKey(page, invite);
  const ai = key.questions[key.current].ai;
  const button = choice(page, correct ? ai : 1 - ai);
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    page.getByText(correct ? /you spotted the slop/i : /that one was real/i),
  ).toBeVisible();
}
export async function login(page: Page, password = PASSWORD) {
  await page.goto('/create');
  await page.getByLabel('Owner password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
}
export const photo = async (name: string, r: number, g: number, b: number) => ({
  name,
  mimeType: 'image/png',
  buffer: await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer(),
});
