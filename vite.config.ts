// vite.config.ts
import { defineConfig, type UserConfig } from 'vite';

// ✅ Node 타입 없어도 안전하게 env 읽기
const env = ((globalThis as any).process?.env ?? {}) as Record<string, string | undefined>;

const isDebug = env.TAURI_DEBUG === 'true';
const host = env.TAURI_DEV_HOST ? env.TAURI_DEV_HOST : false;

const config: UserConfig = {
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host, // string | false OK
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    minify: isDebug ? false : 'esbuild', // ✅ boolean | 'esbuild'
    sourcemap: isDebug,
  },
};

export default defineConfig(config);
