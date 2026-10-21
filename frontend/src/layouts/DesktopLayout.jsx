// Khung màn hình máy tính cho Administrator và Dispatcher: thanh điều hướng trái + vùng nội dung.
import {
  KeyRound, LayoutDashboard, LogOut, Navigation, Package, Route, TriangleAlert, Truck, UserPlus, Users, Warehouse,
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router'
import { useAuth } from '../auth.jsx'
import { Avatar } from '../components/ui.jsx'
import { ROLE } from '../format.js'

const NAV = {
  dispatcher: [
    ['ĐIỀU PHỐI', [
      ['/dispatcher', 'Tổng quan', LayoutDashboard, true],
      ['/dispatcher/orders', 'Đơn hàng', Package],
      ['/dispatcher/failed-orders', 'Đơn chưa giao được', TriangleAlert],
      ['/dispatcher/planning', 'Lập kế hoạch', Route],
      ['/dispatcher/trips', 'Theo dõi chuyến', Navigation],
    ]],
    ['NGUỒN LỰC', [
      ['/dispatcher/drivers', 'Driver', Users],
      ['/dispatcher/vehicles', 'Phương tiện', Truck],
      ['/dispatcher/depot', 'Kho', Warehouse],
    ]],
  ],
  administrator: [
    ['QUẢN TRỊ', [
      ['/admin/accounts', 'Tài khoản người dùng', Users, true],
      ['/admin/accounts/new', 'Cấp tài khoản', UserPlus],
    ]],
  ],
}

export default function DesktopLayout() {
  const { user, logout } = useAuth()
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-row">
          <span className="brand-logo"><Truck size={20} /></span>
          <div className="col" style={{ gap: 0 }}>
            <span className="strong">Điều hành giao hàng</span>
            <span className="caption muted">Kho Hải Châu</span>
          </div>
        </div>
        {NAV[user.role].map(([group, items]) => (
          <nav key={group} className="col" style={{ gap: 2 }} aria-label={group}>
            <span className="nav-group">{group}</span>
            {items.map(([to, label, Icon, end]) => (
              <NavLink key={to} to={to} end={end} className="nav-item">
                <Icon size={18} /> {label}
              </NavLink>
            ))}
          </nav>
        ))}
        <div className="sidebar-user">
          <Avatar name={user.fullName || user.username} />
          <div className="col grow" style={{ gap: 0 }}>
            <span className="strong">{user.fullName || user.username}</span>
            <span className="caption muted">{ROLE[user.role]}</span>
          </div>
          <NavLink to="/account/password" className="btn ghost icon-only" title="Đổi mật khẩu"><KeyRound size={18} /></NavLink>
          <button type="button" className="btn ghost icon-only" title="Đăng xuất" onClick={logout}><LogOut size={18} /></button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
