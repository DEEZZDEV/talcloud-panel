import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Découpage des dépendances en quelques bundles stables (meilleur cache navigateur). */
const vendorGroups: [name: string, pattern: RegExp][] = [
  ['react', /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run|use-sync-external-store|clsx)[\\/]/],
  ['charts', /node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|internmap|decimal\.js-light|es-toolkit|immer|reselect|@reduxjs|redux|redux-thunk|react-redux|eventemitter3|tiny-invariant)[\\/]/],
  ['motion', /node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/],
  ['ui', /node_modules[\\/](@radix-ui|@floating-ui|cmdk|sonner|input-otp|lucide-react|react-remove-scroll[^\\/]*|react-style-singleton|use-callback-ref|use-sidecar|aria-hidden|class-variance-authority|tailwind-merge)[\\/]/],
  ['data', /node_modules[\\/](@tanstack|zod|react-hook-form|@hookform|date-fns|dompurify)[\\/]/],
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // changeOrigin: false → l'en-tête Origin du navigateur est transmis tel quel (contrôle CSRF du serveur).
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Groupes explicites (Vite 8 / Rolldown), par priorité décroissante : React d'abord, pour qu'il ne soit
        // pas entraîné dans le bundle des graphiques avec les dépendances de Recharts.
        codeSplitting: {
          groups: vendorGroups.map(([name, test], index) => ({ name, test, priority: vendorGroups.length - index })),
        },
      },
    },
  },
});
