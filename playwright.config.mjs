// Browser tests for the client half, run against the stage (`stage/server.mjs`).
// `npm run test:ui`. Separate from `npm test` on purpose: the Node suite stays
// fast and dependency-free; this one needs the Chromium Playwright ships.
import { defineConfig } from '@playwright/test'

const PORT = Number(process.env.STAGE_PORT ?? '4173')

export default defineConfig({
  testDir: 'stage/tests',
  testMatch: /.*\.spec\.mjs$/u,
  timeout: 20_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node stage/server.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/__stage/fixtures`,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
