import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // Les dépendances restent dans node_modules (modules natifs : better-sqlite3, @node-rs/argon2).
  skipNodeModulesBundle: true,
});
