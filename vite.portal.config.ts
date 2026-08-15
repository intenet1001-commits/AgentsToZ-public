import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createBuildInfo } from './build-info';

export default defineConfig(({ command }) => ({
  define: {
    __BUILD_INFO__: JSON.stringify(createBuildInfo({ command })),
  },
  plugins: [react()],
  resolve: {
    mainFields: ['module', 'browser', 'main'],
    // ⚠️ lucide-react 를 CJS 번들로 alias 하지 말 것 — CJS 는 트리셰이킹이 안 되어
    // 쓰지도 않는 아이콘 전량이 번들에 실린다(실측: 959KB 청크의 59.6%). ESM 진입점을
    // 그대로 두면 실제로 import 한 아이콘만 남는다.
  },
  build: {
    outDir: 'dist-portal',
    rollupOptions: {
      input: { index: 'portal.html', setup: 'setup.html' },
    },
  },
  optimizeDeps: {
    include: ['lucide-react', '@supabase/supabase-js', '@supabase/realtime-js'],
  },
}));
