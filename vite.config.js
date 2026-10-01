import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5184, strictPort: true },
  preview: { host: '127.0.0.1', port: 5184, strictPort: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@aztec/bb.js', '@noir-lang/noir_js', '@noir-lang/acvm_js', '@noir-lang/noirc_abi'] },
});
