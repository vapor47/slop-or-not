import { test, expect } from '@playwright/test';
import {
  seedGame,
  expireGame,
  startInvite,
  answer,
  answerKey,
  playId,
  choice,
  progress,
} from './helpers.ts';

const isImage = (url: URL) => /^\/api\/plays\/[\w-]+\/images\//.test(url.pathname);

test('guest plays a full game and sees the score', async ({ page }) => {
  const { invite } = await seedGame(page.request, 3, 'Full run');
  await startInvite(page, invite);
  await progress(page, 1, 3);
  await answer(page, invite, true);
  await page.getByRole('button', { name: /next/i }).click();
  await progress(page, 2, 3);
  await answer(page, invite, true);
  await page.getByRole('button', { name: /next/i }).click();
  await progress(page, 3, 3);
  await answer(page, invite, false);
  await page.getByRole('button', { name: /see my score/i }).click();
  await expect(page.getByText('2 / 3', { exact: true })).toBeVisible();
  await expect(page.getByText(/some slop is surprisingly convincing/i)).toBeVisible();
});

test('a failed image load can be retried without losing progress', async ({ page }) => {
  const { invite } = await seedGame(page.request, 2, 'Flaky images');
  // Retry appends ?retry=<timestamp>, so match on the path rather than a glob.
  await page.route(isImage, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"down"}',
    }),
  );
  await startInvite(page, invite);
  await expect(page.getByText(/an image didn.t load/i)).toBeVisible();
  const retry = page.getByRole('button', { name: /retry images/i });
  await expect(retry).toBeVisible();
  await expect(choice(page, 0)).toBeDisabled();
  await expect(choice(page, 1)).toBeDisabled();

  await page.unroute(isImage);
  await retry.click();
  // The app hides the button with the `hidden` attribute; see the visibility test below.
  await expect(retry).toHaveAttribute('hidden');
  await expect(page.getByText(/an image didn.t load/i)).toBeHidden();
  await expect(choice(page, 0)).toBeEnabled();
  await expect(choice(page, 1)).toBeEnabled();
  await progress(page, 1, 2);
  await answer(page, invite, true);
});

test('the Retry images button is not shown when images load', async ({ page }) => {
  // Known bug: `button { display: inline-block }` in public/style.css overrides the `hidden`
  // attribute, so the button is always visible. Remove test.fail() once [hidden] is styled.
  test.fail();
  const { invite } = await seedGame(page.request, 1, 'Healthy images');
  await startInvite(page, invite);
  await expect(choice(page, 0)).toBeEnabled();
  await expect(page.getByRole('button', { name: /retry images/i })).toBeHidden({ timeout: 2000 });
});

test('refreshing during feedback keeps the answer and the Next button', async ({ page }) => {
  const { invite } = await seedGame(page.request, 2, 'Refresh');
  await startInvite(page, invite);
  await answer(page, invite, false);
  await page.reload();
  await progress(page, 1, 2);
  await expect(page.getByText(/that one was real/i)).toBeVisible();
  await expect(choice(page, 0)).toBeDisabled();
  await expect(choice(page, 1)).toBeDisabled();
  await page.getByRole('button', { name: /next/i }).click();
  await progress(page, 2, 2);
});

test('a playthrough resumes later from the same browser', async ({ page, context }) => {
  const { invite } = await seedGame(page.request, 3, 'Resume');
  await startInvite(page, invite);
  await answer(page, invite, true);
  await page.getByRole('button', { name: /next/i }).click();
  await progress(page, 2, 3);
  const id = await playId(page, invite);
  await page.close();

  // A new tab in the same browser profile (localStorage survives) picks up where it left off.
  const later = await context.newPage();
  await later.goto('/g/' + invite);
  await progress(later, 2, 3);
  await expect(later.getByRole('button', { name: /let.s play/i })).toHaveCount(0);
  expect(await playId(later, invite)).toBe(id);
  await expect(later.getByText(/you spotted the slop/i)).toHaveCount(0);
});

test('double-clicking Next advances exactly one question', async ({ page }) => {
  const { invite } = await seedGame(page.request, 3, 'Double click');
  await startInvite(page, invite);
  await answer(page, invite, true);
  await page.getByRole('button', { name: /next/i }).dblclick();
  await progress(page, 2, 3);
  const key = await answerKey(page, invite);
  expect(key.current).toBe(1);
  expect(key.questions[1].chosen).toBeNull();
  await expect(page.getByRole('button', { name: /next/i })).toHaveCount(0);
  await expect(page.getByText(/you spotted the slop|that one was real/i)).toHaveCount(0);
});

test('Play Again starts a fresh playthrough', async ({ page }) => {
  const { invite } = await seedGame(page.request, 1, 'Replay');
  await startInvite(page, invite);
  await answer(page, invite, true);
  const first = await playId(page, invite);
  await page.getByRole('button', { name: /see my score/i }).click();
  await expect(page.getByText('1 / 1', { exact: true })).toBeVisible();
  await expect(page.getByText(/you saw right through the slop/i)).toBeVisible();

  await page.getByRole('button', { name: /play again/i }).click();
  await progress(page, 1, 1);
  await expect(page.getByText(/you spotted the slop|that one was real/i)).toHaveCount(0);
  const second = await playId(page, invite);
  expect(second).not.toBe(first);
  const key = await answerKey(page, invite);
  expect(key.current).toBe(0);
  expect(key.questions[0].chosen).toBeNull();
  // The replay survives a refresh too.
  await page.reload();
  await progress(page, 1, 1);
});

test.describe('expired and unknown links', () => {
  test('opening an expired invite shows an error', async ({ page }) => {
    const { invite } = await seedGame(page.request, 1, 'Expired');
    await expireGame(page.request, invite);
    await page.goto('/g/' + invite);
    await expect(page.getByRole('heading', { name: /can.t play/i })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('This game has expired.');
    await expect(page.getByRole('button', { name: /let.s play/i })).toHaveCount(0);
  });

  test('a game expiring mid-play blocks the saved playthrough', async ({ page }) => {
    const { invite } = await seedGame(page.request, 2, 'Expires mid-play');
    await startInvite(page, invite);
    await answer(page, invite, true);
    await expireGame(page.request, invite, true);
    await page.reload();
    await expect(page.getByRole('heading', { name: /can.t play/i })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('This game has expired.');
    await expect(page.getByRole('heading', { name: 'Which one is slop?' })).toHaveCount(0);
  });

  test('an unknown invite is unavailable', async ({ page }) => {
    await page.goto('/g/no-such-invite-0000');
    await expect(page.getByRole('alert')).toHaveText('This game is unavailable.');
    await page.getByRole('link', { name: 'Back home' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});
