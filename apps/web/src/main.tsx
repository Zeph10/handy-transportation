import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { ConfirmProvider, Loading, ToastProvider } from '@/components/ui';
import { SessionProvider } from '@/features/auth/session';
import { AuthCallbackPage, LoginPage, PendingPage } from '@/features/auth/LoginPage';
import { AppShell, RequireAdmin, RequireApproved, RequireSession, HomeRedirect } from '@/routes/AppShell';

// Driver pages (small, loaded eagerly so the main screen opens fast on phones)
import { DriverAvailabilityPage } from '@/features/driver/AvailabilityPage';
import { WeeklySchedulePage } from '@/features/driver/WeeklySchedulePage';
import { TimeOffPage } from '@/features/driver/TimeOffPage';
import { VehiclesPage } from '@/features/driver/VehiclesPage';
import { RatesPage } from '@/features/driver/RatesPage';
import { ProfilePage } from '@/features/driver/ProfilePage';
import { ChangesPage } from '@/features/driver/ChangesPage';

// Admin pages (loaded on demand; exports pull in heavy libraries)
const AdminDashboard = lazy(() => import('@/features/admin/DashboardPage'));
const AdminCalendar = lazy(() => import('@/features/admin/MasterCalendarPage'));
const AdminReservations = lazy(() => import('@/features/admin/ReservationsPage'));
const AdminReservation = lazy(() => import('@/features/admin/ReservationDetailPage'));
const AdminDrivers = lazy(() => import('@/features/admin/DriversPage'));
const AdminDriver = lazy(() => import('@/features/admin/DriverDetailPage'));
const AdminApprovals = lazy(() => import('@/features/admin/ApprovalsPage'));
const AdminSettings = lazy(() => import('@/features/admin/SettingsPage'));
const AdminIntegrations = lazy(() => import('@/features/admin/IntegrationsPage'));
const AdminExports = lazy(() => import('@/features/admin/ExportsPage'));
const AdminAudit = lazy(() => import('@/features/admin/AuditPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: 0 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <SessionProvider>
            <BrowserRouter>
              <Suspense fallback={<Loading />}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/auth/callback" element={<AuthCallbackPage />} />
                  <Route element={<RequireSession />}>
                    <Route path="/pending" element={<PendingPage />} />
                    <Route element={<RequireApproved />}>
                      <Route element={<AppShell />}>
                        <Route index element={<HomeRedirect />} />
                        <Route path="driver" element={<DriverAvailabilityPage />} />
                        <Route path="driver/schedule" element={<WeeklySchedulePage />} />
                        <Route path="driver/time-off" element={<TimeOffPage />} />
                        <Route path="driver/vehicles" element={<VehiclesPage />} />
                        <Route path="driver/rates" element={<RatesPage />} />
                        <Route path="driver/profile" element={<ProfilePage />} />
                        <Route path="driver/changes" element={<ChangesPage />} />
                        <Route path="admin" element={<RequireAdmin />}>
                          <Route index element={<AdminDashboard />} />
                          <Route path="calendar" element={<AdminCalendar />} />
                          <Route path="reservations" element={<AdminReservations />} />
                          <Route path="reservations/:id" element={<AdminReservation />} />
                          <Route path="drivers" element={<AdminDrivers />} />
                          <Route path="drivers/:id" element={<AdminDriver />} />
                          <Route path="approvals" element={<AdminApprovals />} />
                          <Route path="settings" element={<AdminSettings />} />
                          <Route path="integrations" element={<AdminIntegrations />} />
                          <Route path="exports" element={<AdminExports />} />
                          <Route path="audit" element={<AdminAudit />} />
                        </Route>
                      </Route>
                    </Route>
                  </Route>
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </BrowserRouter>
          </SessionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
