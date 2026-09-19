/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {pickDirPlugin} from './vite-plugin-pick-dir.ts';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), pickDirPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/v1': 'http://127.0.0.1:8090',
        '/foyer': 'http://127.0.0.1:8092',
        '/s3': {
          target: 'http://127.0.0.1:19002',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/s3/, '') || '/',
        },
      },
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
