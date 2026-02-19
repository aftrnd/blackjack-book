import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const githubPagesBasePath =
  process.env.GITHUB_ACTIONS && repositoryName ? `/${repositoryName}/` : '/'

// https://vite.dev/config/
export default defineConfig({
  base: githubPagesBasePath,
  plugins: [react()],
})
