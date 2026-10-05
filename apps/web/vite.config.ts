import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * GitHub Pages 的项目页面部署在 `https://<用户>.github.io/<仓库名>/`，
 * 所以构建产物里的资源路径必须带上 `/<仓库名>/` 前缀，否则全部 404。
 *
 * 优先级：VITE_BASE_PATH 环境变量 > GITHUB_REPOSITORY 推导 > '/'
 * 本地开发与 preview 都不受影响（回落到 '/'）。
 */
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.VITE_BASE_PATH ?? (repoName ? `/${repoName}/` : '/');

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@cyscc/core': resolve(here, '../../packages/core/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    // 事件卡 JSON 会被打进 bundle；提高警告阈值避免噪音
    chunkSizeWarningLimit: 900,
  },
  server: {
    fs: {
      // 允许读取仓库根的 data/ 目录（事件卡 JSON 在引擎外部）
      allow: [resolve(here, '../..')],
    },
  },
});
