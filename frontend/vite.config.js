import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Trong lúc phát triển, mọi yêu cầu /api được chuyển tiếp tới Backend (mặc định cổng 3000).
// Đổi bằng biến môi trường API_TARGET nếu Backend chạy ở cổng khác.
// npm run dev:phone (chế độ phone): mở cho các máy cùng mạng LAN và dùng HTTPS với chứng chỉ tự ký, vì trình duyệt điện thoại
// chỉ cho lấy vị trí và giữ màn hình sáng trên trang HTTPS. Điện thoại mở https://<IP máy tính>:5173 và chấp nhận chứng chỉ.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'phone' ? [basicSsl()] : [])],
  server: {
    host: mode === 'phone' ? true : undefined,
    proxy: {
      '/api': process.env.API_TARGET || 'http://localhost:3000',
    },
  },
}))
