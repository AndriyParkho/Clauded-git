import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
// Une 2ᵉ instance (test) : `API_PORT=4848 WEB_PORT=5174` à côté de celle de tous les jours.
const api = `127.0.0.1:${process.env.API_PORT ?? 4747}`;

export default defineConfig({
    root,
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        port: Number(process.env.WEB_PORT ?? 5173),
        strictPort: true,
        proxy: {
            '/api': `http://${api}`,
            '/artifacts': `http://${api}`,
            '/ws': { target: `ws://${api}`, ws: true },
        },
        fs: { allow: ['..'] },
    },
    build: { outDir: 'dist', emptyOutDir: true },
});
