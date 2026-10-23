// Thành phần giao diện dùng chung, tương ứng các component trong trang Design System của Figma.
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'
import { initials } from '../format.js'

export function Button({ variant = 'primary', size, block, icon: Icon, loading, children, className = '', ...rest }) {
  const cls = ['btn', variant, size === 'large' && 'large', block && 'block', !children && 'icon-only', className].filter(Boolean).join(' ')
  return (
    // disabled đặt sau {...rest} để nút luôn khóa khi đang gửi, kể cả khi nơi gọi truyền disabled={false}
    <button type="button" className={cls} {...rest} disabled={loading || rest.disabled}>
      {loading ? <LoaderCircle size={18} className="spin" /> : Icon && <Icon size={18} />}
      {children}
    </button>
  )
}

/** Nhãn trạng thái. tone: neutral | info | purple | success | warning | danger */
export function Badge({ tone = 'neutral', large, children }) {
  return <span className={`badge ${tone}${large ? ' large' : ''}`}>{children}</span>
}

export const StatusBadge = ({ map, value, large }) => {
  const [label, tone] = map[value] || [value, 'neutral']
  return <Badge tone={tone} large={large}>{label}</Badge>
}

export function Card({ title, extra, tone, compact, className = '', children, ...rest }) {
  return (
    <section className={['card', compact && 'compact', tone && `tone-${tone}`, className].filter(Boolean).join(' ')} {...rest}>
      {(title || extra) && (
        <div className="section-title">
          {typeof title === 'string' ? <h3 className="h4">{title}</h3> : title}
          {extra}
        </div>
      )}
      {children}
    </section>
  )
}

export function PageHeader({ title, badge, subtitle, actions }) {
  return (
    <header className="page-header">
      <div className="col">
        <div className="row">
          <h1 className="h1">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="secondary">{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  )
}

export function Metric({ label, value, hint, icon: Icon, tone }) {
  return (
    <div className={`card compact metric${tone === 'warning' ? ' warning' : ''}`}>
      <div className="metric-icon">{Icon && <Icon size={20} />}</div>
      <div className="col">
        <span className="secondary medium">{label}</span>
        <span className="metric-value tabular">{value}</span>
        {hint && <span className="caption muted">{hint}</span>}
      </div>
    </div>
  )
}

export function Stat({ label, value, sub, subTone, sep, valueClass = 'h3', valueTone }) {
  return (
    <div className={`stat${sep ? ' sep' : ''}`}>
      <span className="caption muted">{label}</span>
      <span className={`${valueClass} ${valueTone || ''}`}>{value}</span>
      {sub && <span className={`caption ${subTone || 'muted'}`}>{sub}</span>}
    </div>
  )
}

const ALERT_ICON = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert }
export function Alert({ tone = 'info', title, children, action }) {
  const Icon = ALERT_ICON[tone]
  return (
    <div className={`alert ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={18} className="alert-icon" />
      <div className="col grow">
        {title && <span className="alert-title">{title}</span>}
        {children && <span className="alert-message">{children}</span>}
      </div>
      {action}
    </div>
  )
}

export function Dialog({ title, tone, children, onCancel, onConfirm, confirmLabel = 'Xác nhận', cancelLabel = 'Hủy', busy, confirmDisabled, wide }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" onMouseDown={e => e.target === e.currentTarget && !busy && onCancel?.()}>
      <div className={`dialog${wide ? ' wide' : ''}`}>
        <h2 className="h3">{title}</h2>
        <div className="stack-sm secondary">{children}</div>
        <div className="row end">
          {onCancel && <Button variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>}
          {onConfirm && <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={confirmDisabled}>{confirmLabel}</Button>}
        </div>
      </div>
    </div>
  )
}

export function Chips({ items, value, onChange }) {
  return (
    <div className="chips" role="tablist">
      {items.map(it => (
        <button key={it.value} type="button" role="tab" aria-selected={value === it.value}
          className={`chip${value === it.value ? ' active' : ''}`} onClick={() => onChange(it.value)}>
          {it.label}{it.count != null && ` (${it.count})`}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, error, helper, children }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : helper && <span className="field-helper">{helper}</span>}
    </label>
  )
}

export function Checkbox({ label, checked, onChange, disabled }) {
  return (
    <label className={`check${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} onChange={e => onChange?.(e.target.checked)} disabled={disabled} />
      <span>{label}</span>
    </label>
  )
}

export function Radio({ label, checked, onChange, name }) {
  return (
    <label className="check">
      <input type="radio" name={name} checked={checked} onChange={() => onChange?.()} />
      <span>{label}</span>
    </label>
  )
}

export function Progress({ value, width = 96, color }) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100
  return <div className="progress" style={{ width }}><span style={{ width: `${pct}%`, background: color }} /></div>
}

export const Avatar = ({ name, muted }) => <span className={`avatar${muted ? ' muted' : ''}`}>{initials(name)}</span>
export const Dot = ({ color, size = 10 }) => <span className="dot" style={{ background: color, width: size, height: size }} />

/** Bảng dữ liệu. columns: [{ key, title, width, render(row) }] */
export function Table({ columns, rows, rowKey = r => r.id, onRowClick, empty }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map(c => <th key={c.key} style={{ width: c.width }}>{c.title}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length}><div className="empty muted">{empty || 'Chưa có dữ liệu'}</div></td></tr>
          )}
          {rows.map(r => (
            <tr key={rowKey(r)} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map(c => <td key={c.key}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Bảng đang tải (E02): giữ khung, các ô hiển thị thanh xám. */
export function TableSkeleton({ columns, rows = 4 }) {
  return (
    <div className="stack-sm">
      <div className="row muted"><LoaderCircle size={16} className="spin" /> Đang tải dữ liệu…</div>
      <Table columns={columns.map(c => ({ ...c, render: () => <div className="skeleton" style={{ width: '70%' }} /> }))}
        rows={Array.from({ length: rows }, (_, i) => ({ id: i }))} />
    </div>
  )
}

export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      {Icon && <div className="icon-wrap tone-info" style={{ width: 56, height: 56 }}><Icon size={28} /></div>}
      <div className="col" style={{ alignItems: 'center' }}>
        <h3 className="h4">{title}</h3>
        {children && <p className="secondary">{children}</p>}
      </div>
      {action}
    </div>
  )
}

export const Loading = ({ label = 'Đang tải…' }) => (
  <div className="row muted" style={{ padding: 24 }}><LoaderCircle size={18} className="spin" /> {label}</div>
)

export const KeyValue = ({ label, value, large }) => (
  <div className="col" style={{ gap: 2 }}>
    <span className="caption muted">{label}</span>
    <span className={large ? 'body-large strong' : 'strong'}>{value}</span>
  </div>
)

/** Dòng điểm dừng (Stop Item). state: done | failed | next | pending */
export function StopItem({ state, seq, name, address, meta, onClick, right }) {
  return (
    <div className={`stop ${state}${onClick ? ' clickable' : ''}`} onClick={onClick}>
      <span className="stop-seq">{seq}</span>
      <div className="col grow">
        <span className="strong">{name}</span>
        <span className="secondary">{address}</span>
        {meta && <span className={`caption ${state === 'failed' ? 'danger' : 'muted'}`}>{meta}</span>}
      </div>
      {right}
    </div>
  )
}

/**
 * Lỗi khi tải trang chi tiết. 404 thì báo không tìm thấy kèm nút về danh sách (thử lại vô ích);
 * lỗi khác vẫn có nút Thử lại.
 */
export function LoadError({ error, onRetry, notFound, back, backLabel = 'Về danh sách' }) {
  if (error?.status === 404) return <Alert tone="warning" title={notFound} action={<Link className="btn secondary" to={back}>{backLabel}</Link>} />
  return <ErrorBox error={error} onRetry={onRetry} />
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null
  const details = Array.isArray(error.details) ? error.details : error.details?.pendingOrderCodes || null
  return (
    <Alert tone="danger" title={error.message || 'Có lỗi xảy ra'} action={onRetry && <Button variant="secondary" onClick={onRetry}>Thử lại</Button>}>
      {details && (
        <span>{details.map(d => (typeof d === 'string' ? d : `${d.code || d.plate || d.id}: ${d.reason}`)).join(' · ')}</span>
      )}
    </Alert>
  )
}
