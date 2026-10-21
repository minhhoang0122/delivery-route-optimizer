// Định tuyến của Web App: mỗi vai trò có khung giao diện và nhóm trang riêng.
import { Navigate, Route, Routes } from 'react-router'
import { useAuth } from './auth.jsx'
import { HOME } from './format.js'
import { Loading } from './components/ui.jsx'
import DesktopLayout from './layouts/DesktopLayout.jsx'
import DriverLayout from './layouts/DriverLayout.jsx'
import AccountsPage from './pages/admin/AccountsPage.jsx'
import CreateAccountPage from './pages/admin/CreateAccountPage.jsx'
import ChangePasswordPage from './pages/ChangePasswordPage.jsx'
import DashboardPage from './pages/dispatcher/DashboardPage.jsx'
import DepotPage from './pages/dispatcher/DepotPage.jsx'
import DriversPage from './pages/dispatcher/DriversPage.jsx'
import FailedOrdersPage from './pages/dispatcher/FailedOrdersPage.jsx'
import OrderFormPage from './pages/dispatcher/OrderFormPage.jsx'
import OrdersPage from './pages/dispatcher/OrdersPage.jsx'
import PlanDraftPage from './pages/dispatcher/PlanDraftPage.jsx'
import PlanningPage from './pages/dispatcher/PlanningPage.jsx'
import ReconcilePage from './pages/dispatcher/ReconcilePage.jsx'
import TrackingPage from './pages/dispatcher/TrackingPage.jsx'
import TripDetailPage from './pages/dispatcher/TripDetailPage.jsx'
import VehiclesPage from './pages/dispatcher/VehiclesPage.jsx'
import CurrentTripPage from './pages/driver/CurrentTripPage.jsx'
import HistoryPage, { HistoryDetailPage } from './pages/driver/HistoryPage.jsx'
import ReturnPage from './pages/driver/ReturnPage.jsx'
import StopResultPage from './pages/driver/StopResultPage.jsx'
import ForbiddenPage, { NotFoundPage } from './pages/ForbiddenPage.jsx'
import LoginPage from './pages/LoginPage.jsx'

/**
 * Chỉ cho vào khi đã đăng nhập đúng vai trò. Đây chỉ là tiện lợi cho người dùng;
 * quyền thật được Backend kiểm tra ở mọi yêu cầu (NFR02).
 */
function RequireRole({ role, children }) {
  const { user, loading } = useAuth()
  if (loading) return <Loading />
  if (!user) return <Navigate to="/login" replace />
  if (user.mustChangePassword) return <Navigate to="/account/password" replace />
  if (role && user.role !== role) return <ForbiddenPage needRole={role} />
  return children
}

function Home() {
  const { user, loading } = useAuth()
  if (loading) return <Loading />
  return <Navigate to={user ? HOME[user.role] : '/login'} replace />
}

function RequireLogin({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <Loading />
  return user ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/account/password" element={<RequireLogin><ChangePasswordPage /></RequireLogin>} />

      <Route path="/admin" element={<RequireRole role="administrator"><DesktopLayout /></RequireRole>}>
        <Route index element={<Navigate to="accounts" replace />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="accounts/new" element={<CreateAccountPage />} />
      </Route>

      <Route path="/dispatcher" element={<RequireRole role="dispatcher"><DesktopLayout /></RequireRole>}>
        <Route index element={<DashboardPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="orders/new" element={<OrderFormPage />} />
        <Route path="orders/:id/edit" element={<OrderFormPage />} />
        <Route path="failed-orders" element={<FailedOrdersPage />} />
        <Route path="planning" element={<PlanningPage />} />
        <Route path="planning/runs/:id" element={<PlanDraftPage />} />
        <Route path="trips" element={<TrackingPage />} />
        <Route path="trips/:id" element={<TripDetailPage />} />
        <Route path="trips/:id/reconcile" element={<ReconcilePage />} />
        <Route path="drivers" element={<DriversPage />} />
        <Route path="vehicles" element={<VehiclesPage />} />
        <Route path="depot" element={<DepotPage />} />
      </Route>

      <Route path="/driver" element={<RequireRole role="driver"><DriverLayout /></RequireRole>}>
        <Route index element={<CurrentTripPage />} />
        <Route path="stops/:stopId" element={<StopResultPage />} />
        <Route path="return" element={<ReturnPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="history/:id" element={<HistoryDetailPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
