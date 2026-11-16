import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS = process.env.SCREENSHOT_DIR || '/opt/cursor/artifacts';

async function waitForCard(page, { reduced = true } = {}) {
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/letian-card-3d/');
  await page.waitForFunction(
    () => window.__card && window.__card.ready && window.__card.frames > 2,
    undefined,
    { timeout: 90_000 },
  );
  await expect(page.locator('#loading')).toHaveClass(/hide/);
  const error = await page.evaluate(() => window.__card.error);
  expect(error).toBeNull();
}

test.beforeAll(() => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
});

test('loads, drags, zooms, and flips', async ({ page }) => {
  await waitForCard(page);

  await expect(page).toHaveTitle('Letian Deng — 3D Card');
  await expect(page.locator('footer')).toContainText('Letian Deng · AI · 营销 · 设计');
  await expect(page.locator('footer a')).toHaveAttribute(
    'href',
    'https://github.com/dengletian702-rgb/letian-card-3d',
  );
  await expect(page.locator('#flip')).toHaveAttribute('aria-label', 'Flip card');
  await expect(page.locator('#flip')).toHaveText('');
  await expect(page.locator('#hint')).not.toContainText(/翻转|flip/i);

  const textures = await page.evaluate(() => window.__card.textures);
  expect(textures.photo?.[0] || 0).toBeGreaterThan(800);
  expect(textures.qr?.[0] || 0).toBeGreaterThan(800);
  expect(await page.evaluate(() => window.__card.autoRotate)).toBe(false);

  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  await page.screenshot({ path: path.join(ARTIFACTS, 'front-desktop.png') });

  const before = await page.evaluate(() => window.__card.camera.slice());
  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 220, startY + 30, { steps: 15 });
  await page.mouse.up();
  await page.waitForFunction(
    (start) => {
      const camera = window.__card.camera;
      const dx = camera[0] - start[0];
      const dy = camera[1] - start[1];
      const dz = camera[2] - start[2];
      return Math.hypot(dx, dy, dz) > 0.35;
    },
    before,
    { timeout: 10_000 },
  );

  const distanceBefore = await page.evaluate(() => window.__card.distance);
  await page.mouse.move(startX, startY);
  await page.mouse.wheel(0, -500);
  await page.waitForFunction(
    (start) => window.__card.distance < start - 0.4,
    distanceBefore,
    { timeout: 10_000 },
  );

  await page.reload();
  await page.waitForFunction(
    () => window.__card && window.__card.ready && window.__card.frames > 2,
    undefined,
    { timeout: 90_000 },
  );
  await page.evaluate(() => window.__card.flip());
  await page.waitForFunction(
    () => window.__card.face === 'back' && !window.__card.flipping && window.__card.burst === 0,
    undefined,
    { timeout: 15_000 },
  );
  await page.screenshot({ path: path.join(ARTIFACTS, 'back-desktop.png') });
});

test('mobile viewport shows the front face', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await waitForCard(page);
  await page.screenshot({ path: path.join(ARTIFACTS, 'front-mobile.png') });
  await page.evaluate(() => {
    window.__card.zoomTo(11);
    window.__card.look(0.72, Math.PI / 2 - 0.38);
  });
  await page.screenshot({ path: path.join(ARTIFACTS, 'three-quarter-mobile.png') });
  await page.evaluate(() => window.__card.look(0, Math.PI / 2));

  const box = await page.locator('#view').boundingBox();
  const before = await page.evaluate(() => window.__card.camera.slice());
  const client = await context.newCDPSession(page);
  const x1 = box.x + box.width * 0.55;
  const y1 = box.y + box.height * 0.48;
  const x2 = x1 - 120;
  const y2 = y1 + 16;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: x1, y: y1 }],
  });
  for (let step = 1; step <= 8; step += 1) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x1 + ((x2 - x1) * step) / 8, y: y1 + ((y2 - y1) * step) / 8 }],
    });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(
    (start) => {
      const camera = window.__card.camera;
      return Math.hypot(camera[0] - start[0], camera[1] - start[1], camera[2] - start[2]) > 0.2;
    },
    before,
    { timeout: 10_000 },
  );
  await page.reload();
  await page.waitForFunction(
    () => window.__card && window.__card.ready && window.__card.frames > 2,
    undefined,
    { timeout: 90_000 },
  );
  await page.evaluate(() => window.__card.flip());
  await page.waitForFunction(
    () => window.__card.face === 'back' && !window.__card.flipping && window.__card.burst === 0,
    undefined,
    { timeout: 15_000 },
  );
  await page.screenshot({ path: path.join(ARTIFACTS, 'back-mobile.png') });
  await context.close();
});

test('relief reads at three-quarter and grazing angles', async ({ page }) => {
  await waitForCard(page);
  await page.evaluate(() => {
    window.__card.zoomTo(11);
    window.__card.look(0.72, Math.PI / 2 - 0.4);
  });
  await page.screenshot({ path: path.join(ARTIFACTS, 'three-quarter-desktop.png') });

  await page.evaluate(() => {
    window.__card.zoomTo(6.2);
    window.__card.look(1.2, Math.PI / 2 - 0.04);
  });
  await page.screenshot({ path: path.join(ARTIFACTS, 'surface-graze.png') });

  await page.evaluate(() => {
    window.__card.zoomTo(4.4);
    window.__card.look(0.95, Math.PI / 2 - 0.48);
  });
  await page.screenshot({ path: path.join(ARTIFACTS, 'surface-closeup.png') });
});

test('hexagram burst is visible mid-flip', async ({ browser }) => {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      reducedMotion: 'no-preference',
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await waitForCard(page, { reduced: false });
    await page.evaluate(() => window.__card.previewFlip(0.42));
    await page.waitForFunction(() => window.__card.burst > 0.3, undefined, { timeout: 10_000 });
    await page.screenshot({ path: path.join(ARTIFACTS, `midflip-${viewport.name}.png`) });
    await context.close();
  }
});
