// A03 Cấp tài khoản (UC01.1).
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../../api.js'
import { Button, ErrorBox, Field, PageHeader } from '../../components/ui.jsx'
import { useAction } from '../../hooks.js'

export default function CreateAccountPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ username: '', fullName: '', role: 'driver', password: '' })
  const action = useAction()
  const set = k => e => setForm({ ...form, [k]: e.target.value })

  async function submit(e) {
    e.preventDefault()
    if (await action.run(() => api('/users', { method: 'POST', body: form }))) navigate('/admin/accounts')
  }

  return (
    <>
      <PageHeader title="Cấp tài khoản" />
      <div className="row top wrap" style={{ gap: 24 }}>
        <form className="card" style={{ width: 640, maxWidth: '100%', gap: 20 }} onSubmit={submit}>
          <h3 className="h4">Thông tin tài khoản</h3>
          <div className="stack">
            <Field label="Tên đăng nhập" helper="Chữ không dấu, số, dấu chấm hoặc gạch dưới">
              <input className="input" value={form.username} onChange={set('username')} required minLength={3} maxLength={50} placeholder="driver6" />
            </Field>
            <Field label="Họ tên">
              <input className="input" value={form.fullName} onChange={set('fullName')} required maxLength={100} />
            </Field>
            <Field label="Vai trò">
              <select className="select" value={form.role} onChange={set('role')}>
                <option value="driver">Driver</option>
                <option value="dispatcher">Dispatcher</option>
                <option value="administrator">Administrator</option>
              </select>
            </Field>
            <Field label="Mật khẩu ban đầu" helper="Ít nhất 8 ký tự">
              <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={8} />
            </Field>
          </div>
          <ErrorBox error={action.error} />
          <hr className="divider" />
          <div className="row end">
            <Button variant="secondary" onClick={() => navigate('/admin/accounts')}>Hủy</Button>
            <Button type="submit" loading={action.busy}>Cấp tài khoản</Button>
          </div>
        </form>
      </div>
    </>
  )
}
