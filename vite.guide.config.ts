import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createBuildInfo } from './build-info';

/**
 * Public, read-only onboarding guide build.
 *
 * Keep this separate from vite.portal.config.ts: the personal portal and setup
 * wizard must never become entries in the public guide deployment.
 */
export default defineConfig(({ command }) => ({
  define: {
    __BUILD_INFO__: JSON.stringify(createBuildInfo({ command })),
  },
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist-guide',
    emptyOutDir: true,
    rollupOptions: {
      input: { guide: 'guide.html' },
    },
  },
}));
