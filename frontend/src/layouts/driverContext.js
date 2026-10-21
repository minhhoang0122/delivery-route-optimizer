// Ngữ cảnh dùng chung của ứng dụng Driver, tách riêng để tải nóng (HMR) không tạo lại ngữ cảnh.
import { createContext, useContext } from 'react'

export const DriverContext = createContext(null)
export const useDriver = () => useContext(DriverContext)
