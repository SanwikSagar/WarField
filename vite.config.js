import { defineConfig } from 'vite';

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.GITHUB_ACTIONS === 'true'
    && repositoryName
    && !repositoryName.toLowerCase().endsWith('.github.io')
    ? `/${repositoryName}/`
    : '/';

export default defineConfig({
  base,
  server: { port: 3000, open: true },
  build: { outDir: 'dist', target: 'esnext' }
});