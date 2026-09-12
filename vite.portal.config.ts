import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createBuildInfo } from './build-info';
import { createReleaseMetadata } from './src/releaseMetadata';

export default defineConfig(({ command }) => {
  const buildInfo = createBuildInfo({ command, tauriVersionPolicy: 'if-present' });
  const releaseMetadata = createReleaseMetadata(buildInfo);
  return ({
  define: {
    // Vercel uploads intentionally exclude src-tauri. The portal still requires
    // build-number.json and validates tauri.conf.json whenever it is present;
    // desktop builds keep createBuildInfo's strict default.
    __BUILD_INFO__: JSON.stringify(buildInfo),
  },
  plugins: [react(), {
    name: 'agentstoz-release-metadata',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'release-meta.json',
        source: JSON.stringify(releaseMetadata, null, 2) + '\n',
      });
    },
  }],
  resolve: {
    mainFields: ['module', 'browser', 'main'],
    // ⚠️ lucide-react 를 CJS 번들로 alias 하지 말 것 — CJS 는 트리셰이킹이 안 되어
    // 쓰지도 않는 아이콘 전량이 번들에 실린다(실측: 959KB 청크의 59.6%). ESM 진입점을
    // 그대로 두면 실제로 import 한 아이콘만 남는다.
  },
  build: {
    outDir: 'dist-portal',
    // Remote CSP allows same-origin font files, not Vite's small data-URL subsets.
    assetsInlineLimit: filePath => /\.woff2?$/i.test(filePath) ? false : undefined,
    rollupOptions: {
      input: {
        index: 'portal.html',
        setup: 'setup.html',
        remote: 'remote/index.html',
      },
    },
  },
  optimizeDeps: {
    include: ['lucide-react', '@supabase/supabase-js', '@supabase/realtime-js'],
  },
  });
});
