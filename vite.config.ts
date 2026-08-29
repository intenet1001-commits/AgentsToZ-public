import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import { createBuildInfo } from './build-info';

export default defineConfig(({ command }) => ({
  define: {
    __BUILD_INFO__: JSON.stringify(createBuildInfo({ command })),
  },
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  optimizeDeps: {
    include: ['@supabase/supabase-js', '@supabase/realtime-js'],
  },
  build: {
    rollupOptions: {
      output: {
        // 벤더 라이브러리를 안정적인 별도 청크로 분리 — lazy 청크(SetupWizard 등)가 벤더를 중복 포함하지 않게 하고 캐싱 granularity 확보
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'supabase': ['@supabase/supabase-js', '@supabase/realtime-js'],
          'icons': ['lucide-react'],
        },
      },
    },
  },
  server: {
    // API 서버와 같은 IPv4 loopback에 바인딩한다. macOS에서 `localhost` 기본값이
    // IPv6(::1)만 열리면 Codex/Orca 내장 브라우저의 127.0.0.1 URL이 연결되지 않는다.
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 9000,
    // 9000 점유 시 9001/9002로 조용히 폴백하며 고아 vite 서버가 쌓이는 것 방지 — 즉시 실패
    strictPort: true,
    watch: {
      // `.claude/`는 앱 소스가 아니라 로컬 설정 + 워크트리 체크아웃이 사는 곳이다.
      // 앱에서 이 프로젝트의 워크트리를 만들면 .claude/worktrees/<브랜치>/ 아래에
      // 저장소 사본과 node_modules 수만 개가 한꺼번에 생기는데, 감시 대상이면
      // vite가 연속 page reload를 쏟아내고 워크트리의 tsconfig.json까지 집어
      // full-reload를 걸어 사용자의 작업 화면이 통째로 끊긴다(파일 폭주로 dev 서버가
      // 죽는 것도 관측됨). 워크트리는 독립 체크아웃이라 감시할 이유가 전혀 없다.
      // ⚠️ `worktrees/`(비숨김)가 새 기본 위치이므로 **반드시 함께 무시**해야 한다.
      //    빠뜨리면 위 증상이 그대로 재현된다(실측: worktrees/<브랜치>/tsconfig.json 감지 →
      //    "Clearing cache and forcing full-reload" 연발 → 화면 상태 초기화).
      ignored: ['**/src-tauri/**', '**/dist/**', '**/.claude/**', '**/worktrees/**'],
    },
    proxy: {
      '/api': {
        // api-server.ts의 리스닝 포트와 동일한 API_PORT 환경변수를 읽어야
        // 워크트리 인스턴스에서 API_PORT를 오버라이드해도 프록시가 올바른 인스턴스로 향한다
        target: `http://localhost:${Number(process.env.API_PORT) || 3001}`,
        changeOrigin: true,
      },
    },
  },
}));
