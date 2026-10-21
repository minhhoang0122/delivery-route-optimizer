// E05 Không đủ quyền: người dùng mở đường dẫn của vai trò khác.
import { Lock } from 'lucide-react'
import { Link } from 'react-router'
import { useAuth } from '../auth.jsx'
import { HOME, ROLE } from '../format.js'

export default function ForbiddenPage({ needRole }) {
  const { user } = useAuth()
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card" style={{ width: 'min(560px, 100%)', padding: '40px 32px', alignItems: 'center', textAlign: 'center', gap: 24 }}>
        <span className="icon-wrap tone-neutral-bg" style={{ width: 80, height: 80 }}><Lock size={40} /></span>
        <div className="stack-sm">
          <h1 className="h3">Bạn không có quyền truy cập trang này</h1>
          <p className="secondary">
            Trang này dành cho {needRole ? ROLE[needRole] : 'vai trò khác'}. Tài khoản {user.username} đang đăng nhập với vai trò {ROLE[user.role]}.
          </p>
        </div>
        <Link className="btn primary" to={HOME[user.role]}>Về trang của tôi</Link>
      </div>
    </div>
  )
}

export function NotFoundPage() {
  return (
    <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="col" style={{ alignItems: 'center', gap: 12 }}>
        <h1 className="h2">Không tìm thấy trang</h1>
        <Link className="btn secondary" to="/">Về trang chủ</Link>
      </div>
    </div>
  )
}
