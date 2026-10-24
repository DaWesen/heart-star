import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const resolveWorkspace = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@heart-star/character-schema': resolveWorkspace(
        '../../packages/character-schema/src/index.ts',
      ),
      '@heart-star/protocol': resolveWorkspace('../../packages/protocol/src/index.ts'),
    },
  },
  build: { target: 'es2022', outDir: 'dist', sourcemap: true },
  server: { port: 5174, strictPort: true },
});
