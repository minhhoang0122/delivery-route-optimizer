// Trạng thái đăng nhập dùng chung cho toàn ứng dụng (React Context).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js'
import { cacheDelete } from './offline.js'

const AuthContext = createContext(null)
const USER_KEY = 'lastmile.user'

// Lưu thông tin người dùng cùng token để Driver mở lại ứng dụng khi mất mạng vẫn vào được chuyến đã tải
const cachedUser = () => { try { return JSON.parse(localStorage.getItem(USER_KEY)) } catch { return null } }
const cacheUser = u => (u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY))

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(null)
  const [loading, setLoading] = useState(Boolean(getToken()))

  const setUser = useCallback(u => { cacheUser(u); setUserState(u) }, [])

  const logout = useCallback(() => {
    // Xóa chuyến đã lưu trên máy của Driver để người đăng nhập sau không xem được.
    // Hàng đợi kết quả chờ gửi vẫn giữ (mỗi thao tác ghi userId), chỉ gửi khi đúng Driver đó đăng nhập lại
    if (cachedUser()?.role === 'driver') cacheDelete('currentTrip').catch(() => {})
    setToken(null)
    setUser(null)
  }, [setUser])

  useEffect(() => {
    setUnauthorizedHandler(logout)
    if (!getToken()) return
    api('/auth/me')
      .then(d => setUser(d.user))
      .catch(e => {
        // Chỉ đăng xuất khi máy chủ từ chối phiên; mất mạng hoặc máy chủ tạm lỗi thì giữ phiên đã lưu
        if (e.status === 0 || e.status >= 500) setUserState(cachedUser())
        else logout()
      })
      .finally(() => setLoading(false))
  }, [logout, setUser])

  const login = useCallback(async (username, password) => {
    const d = await api('/auth/login', { method: 'POST', body: { username, password } })
    setToken(d.token)
    setUser(d.user)
    return d.user
  }, [setUser])

  const value = useMemo(() => ({ user, loading, login, logout, setUser }), [user, loading, login, logout, setUser])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext)
