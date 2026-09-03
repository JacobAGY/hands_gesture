import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// (config change forces vite auto-restart and clears transform cache)
export default defineConfig({
  plugins: [react()],
  // GitHub Pages 项目页部署在 https://jacobagy.github.io/hands_gesture/ 下，
  // 必须加 base；本地开发(GITHUB_ACTIONS 为空)保持 "/" 不变
  base: process.env.GITHUB_ACTIONS === 'true' ? '/hands_gesture/' : '/',
  server: {
    port: 5176,
    strictPort: true,
    watch: { usePolling: true, interval: 300 },
  },
})
