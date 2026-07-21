import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

function resolveBasePath(): string {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return '/';
  }

  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    return '/';
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    return '/';
  }

  if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return '/';
  }

  return `/${repo}/`;
}

// https://vitejs.dev/config/
export default defineConfig((env) => ({
  plugins:
    env.mode === 'test'
      ? [react(), tsconfigPaths()]
      : [react(), tsconfigPaths(), nodePolyfills()],
  base: resolveBasePath(),
  build: {
    outDir: './dist'
  },
  worker: {
    format: 'es',
    plugins: () => [tsconfigPaths()]
  },
  test: {
    dir: './',
    deps: {
      interopDefault: true
    },
    globals: true,
    setupFiles: './test/setup.ts',
    coverage: {
      reporter: ['text', 'json', 'html']
    }
  }
}));
