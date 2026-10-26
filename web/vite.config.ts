import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // `vite build --mode demo` makes a self-contained preview with sample data (see src/demo).
  const demo = mode === 'demo';
  return {
    plugins: [react()],
    base: demo ? './' : '/',
    server: {
      port: 5173,
      proxy: {
        '/api': { target: 'http://localhost:3000', changeOrigin: false },
      },
    },
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
      sourcemap: false,
      // One JS file, one CSS file and fonts inlined, so scripts/inline-demo.mjs can make a single page.
      ...(demo
        ? {
            assetsInlineLimit: 10_000_000,
            cssCodeSplit: false,
            modulePreload: false,
            rolldownOptions: { output: { codeSplitting: false } },
          }
        : {}),
    },
  };
});
