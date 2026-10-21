import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Trong lúc phát triển, mọi yêu cầu /api được chuyển tiếp tới Backend (mặc định cổng 3000).
// Đổi bằng biến môi trường API_TARGET nếu Backend chạy ở cổng khác.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.API_TARGET || 'http://localhost:3000',
    },
  },
})
