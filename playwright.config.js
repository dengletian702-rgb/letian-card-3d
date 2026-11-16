import { defineConfig } from '@playwright/test';

const chrome = process.env.CHROME_PATH || '/opt/google/chrome/chrome';

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    launchOptions: {
      executablePath: chrome,
      args: [
        '--use-angle=swiftshader',
        '--use-gl=angle',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--disable-gpu-sandbox',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    },
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/letian-card-3d/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
