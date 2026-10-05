import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cyscc/core': resolve(here, '../../packages/core/src/index.ts'),
    },
  },
  server: {
    fs: {
      // 允许读取仓库根的 data/ 目录（事件卡 JSON 在引擎外部）
      allow: [resolve(here, '../..')],
    },
  },
});
