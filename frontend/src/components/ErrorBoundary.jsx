// Chặn lỗi khi dựng giao diện của một trang: hiện thông báo ngắn và nút Tải lại thay vì để trắng màn hình.
import { Component } from 'react'
import { RefreshCw } from 'lucide-react'
import { Alert, Button } from './ui.jsx'

/** resetKey: đổi giá trị (ví dụ đường dẫn trang) thì bỏ lỗi cũ và dựng lại nội dung. */
export default class ErrorBoundary extends Component {
  state = { error: null, key: undefined }

  static getDerivedStateFromError(error) {
    return { error }
  }

  static getDerivedStateFromProps(props, state) {
    // Chuyển sang trang khác thì thử dựng lại, không giữ lỗi của trang trước
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey }
    return null
  }

  componentDidCatch(error, info) {
    console.error(error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 16 }}>
        <Alert tone="danger" title="Không hiển thị được trang này"
          action={<Button variant="secondary" icon={RefreshCw} onClick={() => window.location.reload()}>Tải lại</Button>} />
      </div>
    )
  }
}
