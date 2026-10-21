// Đổi mật khẩu. Tài khoản mới cấp bắt buộc qua trang này ở lần đăng nhập đầu (A03).
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { HOME } from '../format.js'
import { Alert, Button, Field } from '../components/ui.jsx'

export default function ChangePasswordPage() {
  const { user, setUser, logout } = useAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ current: '', next: '', again: '' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const set = k => e => setForm({ ...form, [k]: e.target.value })

  async function submit(e) {
    e.preventDefault()
    if (form.next !== form.again) return setError('Hai lần nhập mật khẩu mới không khớp')
    setBusy(true)
    setError(null)
    try {
      const d = await api('/auth/change-password', { method: 'POST', body: { currentPassword: form.current, newPassword: form.next } })
      setUser(d.user)
      navigate(HOME[user.role], { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="card" style={{ width: 'min(420px, 100%)', padding: 32, gap: 20 }} onSubmit={submit}>
        <div className="row">
          <span className="icon-wrap tone-info"><KeyRound size={18} /></span>
          <div className="col">
            <h1 className="h3">Đổi mật khẩu</h1>
            <span className="caption muted">{user.username}</span>
          </div>
        </div>
        {user.mustChangePassword && <Alert tone="info" title="Cần đổi mật khẩu ban đầu">Tài khoản mới phải đặt mật khẩu riêng trước khi sử dụng.</Alert>}
        <Field label="Mật khẩu hiện tại">
          <input className="input" type="password" autoComplete="current-password" value={form.current} onChange={set('current')} required />
        </Field>
        <Field label="Mật khẩu mới" helper="Ít nhất 8 ký tự">
          <input className="input" type="password" autoComplete="new-password" minLength={8} value={form.next} onChange={set('next')} required />
        </Field>
        <Field label="Nhập lại mật khẩu mới">
          <input className="input" type="password" autoComplete="new-password" value={form.again} onChange={set('again')} required />
        </Field>
        {error && <Alert tone="danger" title={error} />}
        <div className="row end">
          {user.mustChangePassword
            ? <Button variant="secondary" onClick={logout}>Đăng xuất</Button>
            : <Button variant="secondary" onClick={() => navigate(-1)}>Hủy</Button>}
          <Button type="submit" loading={busy}>Lưu mật khẩu</Button>
        </div>
      </form>
    </div>
  )
}
