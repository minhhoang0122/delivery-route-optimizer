// A01 Đăng nhập: trang dùng chung cho Administrator, Dispatcher và Driver.
import { Truck } from 'lucide-react'
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useAuth } from '../auth.jsx'
import { HOME } from '../format.js'
import { Alert, Button, Field } from '../components/ui.jsx'

export default function LoginPage() {
  const { user, login } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  if (user) return <Navigate to={user.mustChangePassword ? '/account/password' : HOME[user.role]} replace />

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const u = await login(username.trim(), password)
      navigate(u.mustChangePassword ? '/account/password' : HOME[u.role], { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="card" style={{ width: 'min(400px, 100%)', padding: 32, gap: 24 }} onSubmit={submit}>
        <div className="col" style={{ alignItems: 'center', gap: 12, textAlign: 'center' }}>
          <span className="brand-logo" style={{ width: 40, height: 40 }}><Truck size={22} /></span>
          <h1 className="h2">Điều hành giao hàng</h1>
        </div>
        <div className="stack">
          <Field label="Tên đăng nhập">
            <input className="input" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} autoFocus required />
          </Field>
          <Field label="Mật khẩu">
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
          </Field>
        </div>
        {error && <Alert tone="danger" title={error} />}
        <Button type="submit" block loading={busy}>Đăng nhập</Button>
      </form>
    </div>
  )
}
