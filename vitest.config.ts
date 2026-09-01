import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@sxs/app-twin-temp-failed-closed': new URL(
        './packages/app-twin-temp-failed-closed/src/index.ts',
        import.meta.url,
      ).pathname,
      '@sxs/device-enless-twin-temp': new URL(
        './packages/device-enless-twin-temp/src/index.ts',
        import.meta.url,
      ).pathname,
      '@sxs/industrial-core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      'node-red-contrib-sxs-industrial': new URL(
        './packages/node-red/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    clearMocks: true,
    include: ['packages/*/test/**/*.test.ts'],
    passWithNoTests: true,
    restoreMocks: true,
  },
});
