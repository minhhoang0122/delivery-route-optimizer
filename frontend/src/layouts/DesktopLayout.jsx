// Khung màn hình máy tính cho Administrator và Dispatcher: thanh điều hướng tối phía trên, nội dung chiếm hết bề rộng.
import { KeyRound, LogOut, Truck } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { useAuth } from '../auth.jsx'
import ErrorBoundary from '../components/ErrorBoundary.jsx'
import { ROLE } from '../format.js'

const NAV = {
  dispatcher: [
    [
      ['/dispatcher', 'Tổng quan', true],
      ['/dispatcher/trips', 'Theo dõi chuyến'],
      ['/dispatcher/planning', 'Lập kế hoạch'],
      ['/dispatcher/orders', 'Đơn hàng'],
      ['/dispatcher/failed-orders', 'Đơn chưa giao được'],
    ],
    [
      ['/dispatcher/drivers', 'Driver'],
      ['/dispatcher/vehicles', 'Phương tiện'],
      ['/dispatcher/depot', 'Kho'],
    ],
  ],
  administrator: [
    [
      ['/admin/accounts', 'Tài khoản người dùng', true],
      ['/admin/accounts/new', 'Cấp tài khoản'],
    ],
  ],
}

export default function DesktopLayout() {
  const { user, logout } = useAuth()
  const { pathname } = useLocation()
  return (
    <div className="shell">
      <header className="appbar">
        <div className="appbar-brand">
          <span className="logo"><Truck size={14} /></span>
          Điều hành giao hàng <small>Kho Hải Châu</small>
        </div>
        <nav aria-label="Điều hướng chính">
          {NAV[user.role].map((group, i) => (
            <div key={i} style={{ display: 'flex' }}>
              {i > 0 && <span className="appbar-sep" />}
              {group.map(([to, label, end]) => <NavLink key={to} to={to} end={end} className="nav-item">{label}</NavLink>)}
            </div>
          ))}
        </nav>
        <div className="appbar-user">
          <div className="who"><span>{user.fullName || user.username}</span><span>{ROLE[user.role]}</span></div>
          <NavLink to="/account/password" className="appbar-btn" title="Đổi mật khẩu"><KeyRound size={16} /></NavLink>
          <button type="button" className="appbar-btn" title="Đăng xuất" onClick={logout}><LogOut size={16} /></button>
        </div>
      </header>
      <main className="main">
        <ErrorBoundary resetKey={pathname}><Outlet /></ErrorBoundary>
      </main>
    </div>
  )
}
