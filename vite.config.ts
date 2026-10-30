import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/deliverables/**', '**/.local/**', '**/runtime/**'] },
  },
  clearScreen: false,
  test: { include: ['src/**/*.test.ts', 'tests/**/*.test.ts'] },
  build: {
    // FINDU_PROFILE_BUILD=1 keeps function names readable in CPU profiles (tests/perf-desktop.mjs --profile 1).
    minify: process.env.FINDU_PROFILE_BUILD !== '1',
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
          controls: ['antd'],
        },
      },
    },
  },
});
