import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  // Compiling Java in the browser is not fast: the toolchain is a ~4MB
  // WebAssembly module and each run is two compilations.
  timeout: 180_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    // Chromium only: the File System Access API and cross-origin isolation
    // behave differently elsewhere, and this is what schools deploy.
    launchOptions: {
      args: ['--no-sandbox'],
      // Escape hatch for sandboxes that ship a pre-installed Chromium whose
      // build number does not match this @playwright/test version.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
    },
  },
  webServer: {
    // `env` rather than a PORT= prefix, so this works on Windows too.
    command: 'node server.mjs',
    env: { PORT: '3100' },
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
