// A03 Cấp tài khoản (UC01.1).
import { Info, Route, Shield, Bike } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../../api.js'
import { Button, Card, ErrorBox, Field, PageHeader } from '../../components/ui.jsx'
import { useAction } from '../../hooks.js'

const ROLE_NOTES = [
  ['Administrator', Shield, 'tone-neutral-bg', 'Cấp tài khoản, gán hoặc đổi vai trò, khóa và mở lại tài khoản. Không tham gia điều phối giao hàng.'],
  ['Dispatcher', Route, 'tone-info', 'Quản lý đơn, Driver, phương tiện và kho. Lập kế hoạch, giao chuyến, duyệt đổi tuyến, đối chiếu và chốt chuyến.'],
  ['Driver', Bike, 'tone-success-bg', 'Chỉ xem chuyến được giao cho mình. Kiểm hàng, ghi kết quả từng điểm và báo về kho khi kết thúc chuyến.'],
]

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
            <Field label="Mật khẩu ban đầu" helper="Người dùng sẽ được yêu cầu đổi mật khẩu ở lần đăng nhập đầu">
              <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={8} />
            </Field>
          </div>
          {form.role === 'driver' && (
            <div className="alert info"><Info size={18} className="alert-icon" />
              <span className="alert-message">Driver mới cần được Dispatcher khai báo hồ sơ và phương tiện trước khi nhận chuyến.</span>
            </div>
          )}
          <ErrorBox error={action.error} />
          <hr className="divider" />
          <div className="row end">
            <Button variant="secondary" onClick={() => navigate('/admin/accounts')}>Hủy</Button>
            <Button type="submit" loading={action.busy}>Cấp tài khoản</Button>
          </div>
        </form>
        <Card title="Quyền theo vai trò" style={{ width: 440, maxWidth: '100%' }}>
          {ROLE_NOTES.map(([name, Icon, tone, desc], i) => (
            <div key={name} className="stack">
              {i > 0 && <hr className="divider" />}
              <div className="row top">
                <span className={`icon-wrap ${tone}`} style={{ borderRadius: 3 }}><Icon size={20} /></span>
                <div className="col">
                  <span className="strong">{name}</span>
                  <span className="secondary">{desc}</span>
                </div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </>
  )
}
