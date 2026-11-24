import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root,
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': 'http://127.0.0.1:4747',
            '/artifacts': 'http://127.0.0.1:4747',
            '/ws': { target: 'ws://127.0.0.1:4747', ws: true },
        },
        fs: { allow: ['..'] },
    },
    build: { outDir: 'dist', emptyOutDir: true },
});
