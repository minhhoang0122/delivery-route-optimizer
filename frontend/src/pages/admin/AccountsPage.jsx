// A02 Tài khoản người dùng và A04 Khóa tài khoản (UC01.2 đổi vai trò, UC01.3 khóa hoặc mở lại).
import { Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../api.js'
import { useAuth } from '../../auth.jsx'
import { Avatar, Badge, Button, Chips, Dialog, ErrorBox, Field, PageHeader, Table, TableSkeleton } from '../../components/ui.jsx'
import { dateTime, ROLE } from '../../format.js'
import { useAction, useLoad } from '../../hooks.js'

const COLUMNS = [
  { key: 'username', title: 'Tên đăng nhập', width: 160 },
  { key: 'name', title: 'Họ tên', width: 240 },
  { key: 'role', title: 'Vai trò', width: 160 },
  { key: 'status', title: 'Trạng thái', width: 150 },
  { key: 'login', title: 'Đăng nhập gần nhất', width: 168 },
  { key: 'actions', title: 'Thao tác', width: 250 },
]

export default function AccountsPage() {
  const { user: me } = useAuth()
  const { data, error, loading, reload } = useLoad(() => api('/users'))
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('all')
  const [lockTarget, setLockTarget] = useState(null)
  const [roleTarget, setRoleTarget] = useState(null)
  const [newRole, setNewRole] = useState('')
  const action = useAction()

  const users = useMemo(() => data?.users ?? [], [data])
  const shown = useMemo(() => users.filter(u =>
    (!search || u.username.toLowerCase().includes(search.toLowerCase()) || (u.fullName || '').toLowerCase().includes(search.toLowerCase()))
    && (!role || u.role === role)
    && (status === 'all' || u.status === status)), [users, search, role, status])

  async function toggleLock() {
    if (!(await action.run(() => api(`/users/${lockTarget.id}/status`, { method: 'PATCH', body: { status: lockTarget.status === 'locked' ? 'active' : 'locked' } })))) return
    setLockTarget(null)
    reload()
  }
  async function changeRole() {
    if (!(await action.run(() => api(`/users/${roleTarget.id}/role`, { method: 'PATCH', body: { role: newRole } })))) return
    setRoleTarget(null)
    reload()
  }

  const columns = COLUMNS.map(c => ({
    ...c,
    render: {
      username: u => <span className="strong">{u.username}</span>,
      name: u => <div className="row" style={{ gap: 8 }}><Avatar name={u.fullName || u.username} muted={u.status === 'locked'} /><span className={u.status === 'locked' ? 'secondary strong' : 'strong'}>{u.fullName || '—'}</span></div>,
      role: u => ROLE[u.role],
      status: u => u.status === 'locked' ? <Badge>Đã khóa</Badge> : u.mustChangePassword ? <Badge tone="info">Chờ đổi mật khẩu</Badge> : <Badge tone="success">Hoạt động</Badge>,
      login: u => <span className={u.status === 'locked' ? 'muted' : ''}>{u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Chưa đăng nhập'}</span>,
      // Không tự khóa hoặc tự đổi vai trò của chính mình
      actions: u => (
        <div className="row" style={{ gap: 4 }}>
          <Button variant="ghost" disabled={u.id === me.id} onClick={() => { setRoleTarget(u); setNewRole(u.role); action.setError(null) }}>Đổi vai trò</Button>
          <Button variant="ghost" disabled={u.id === me.id} onClick={() => { setLockTarget(u); action.setError(null) }}>{u.status === 'locked' ? 'Mở lại' : 'Khóa'}</Button>
        </div>
      ),
    }[c.key],
  }))

  return (
    <>
      <PageHeader title="Tài khoản người dùng"
        actions={<Link className="btn primary" to="/admin/accounts/new"><Plus size={18} /> Cấp tài khoản</Link>} />
      <div className="row between wrap" style={{ alignItems: 'flex-end' }}>
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Tìm kiếm">
            <div className="input-icon" style={{ width: 360 }}>
              <Search size={16} />
              <input className="input" placeholder="Tìm theo tên đăng nhập hoặc họ tên" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </Field>
          <Field label="Vai trò">
            <select className="select" style={{ width: 220 }} value={role} onChange={e => setRole(e.target.value)}>
              <option value="">Tất cả</option>
              {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
        <Chips value={status} onChange={setStatus} items={[
          { value: 'all', label: 'Tất cả', count: users.length },
          { value: 'active', label: 'Hoạt động', count: users.filter(u => u.status === 'active').length },
          { value: 'locked', label: 'Đã khóa', count: users.filter(u => u.status === 'locked').length },
        ]} />
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <TableSkeleton columns={COLUMNS} /> : <Table columns={columns} rows={shown} empty="Không có tài khoản phù hợp" />}

      {lockTarget && (
        <Dialog tone={lockTarget.status === 'locked' ? undefined : 'danger'}
          title={lockTarget.status === 'locked' ? `Mở lại tài khoản ${lockTarget.username}?` : `Khóa tài khoản ${lockTarget.username}?`}
          confirmLabel={lockTarget.status === 'locked' ? 'Mở lại' : 'Khóa tài khoản'} busy={action.busy}
          onCancel={() => setLockTarget(null)} onConfirm={toggleLock}>
          {lockTarget.status === 'locked'
            ? <p>{lockTarget.fullName || lockTarget.username} sẽ đăng nhập lại được.</p>
            : <p>{lockTarget.fullName || lockTarget.username} sẽ không đăng nhập được{lockTarget.activeTrip ? ` · đang giữ chuyến ${lockTarget.activeTrip.code}` : ''}.</p>}
          <ErrorBox error={action.error} />
        </Dialog>
      )}
      {roleTarget && (
        <Dialog title={`Đổi vai trò của ${roleTarget.username}`} confirmLabel="Lưu vai trò" busy={action.busy}
          confirmDisabled={newRole === roleTarget.role} onCancel={() => setRoleTarget(null)} onConfirm={changeRole}>
          <Field label="Vai trò mới">
            <select className="select" value={newRole} onChange={e => setNewRole(e.target.value)}>
              {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <ErrorBox error={action.error} />
        </Dialog>
      )}
    </>
  )
}
