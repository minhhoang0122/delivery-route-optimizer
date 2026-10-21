import { Routes, Route, Navigate } from 'react-router'
import LoginPage from './pages/LoginPage.jsx'
import DispatcherDashboardPage from './pages/DispatcherDashboardPage.jsx'

function App() {
  return (
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dispatcher" element={<DispatcherDashboardPage />} />
        <Route path="*" element={<h1>Không tìm thấy trang</h1>} />
      </Routes>
  )
}

export default App