import { useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Loading, Notice, ThemeToggle, cx } from '@/components/ui';
import { useSession } from '@/features/auth/session';
import { getPublicSettings } from '@/lib/api';

export function RequireSession() {
  const { loading, session } = useSession();
  const loc = useLocation();
  if (loading) return <Loading label="Opening…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}

export function RequireApproved() {
  const { isApproved, profile, error, refresh } = useSession();
  if (error) return <div className="p-6"><Notice tone="error">{error} <Button size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button></Notice></div>;
  if (!profile && !isApproved) return <Loading />;
  if (!isApproved) return <Navigate to="/pending" replace />;
  return <Outlet />;
}

/** UX guard only; the database enforces admin access independently. */
export function RequireAdmin() {
  const { isAdmin } = useSession();
  if (!isAdmin) return <Navigate to="/driver" replace />;
  return <Outlet />;
}

export function HomeRedirect() {
  const { isAdmin } = useSession();
  return <Navigate to={isAdmin ? '/admin' : '/driver'} replace />;
}

const driverNav = [
  { to: '/driver', label: 'My availability', end: true },
  { to: '/driver/schedule', label: 'Weekly schedule' },
  { to: '/driver/time-off', label: 'Time off' },
  { to: '/driver/vehicles', label: 'Vehicles' },
  { to: '/driver/rates', label: 'Destinations & rates' },
  { to: '/driver/changes', label: 'Changes & requests' },
  { to: '/driver/profile', label: 'Profile' },
];

const adminNav = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/calendar', label: 'Master calendar' },
  { to: '/admin/reservations', label: 'Reservations' },
  { to: '/admin/drivers', label: 'Drivers' },
  { to: '/admin/approvals', label: 'Approvals' },
  { to: '/admin/settings', label: 'Settings' },
  { to: '/admin/integrations', label: 'Integrations' },
  { to: '/admin/exports', label: 'Exports & backups' },
  { to: '/admin/audit', label: 'Audit log' },
];

function NavList({ items, onNavigate }: { items: { to: string; label: string; end?: boolean }[]; onNavigate?: () => void }) {
  return (
    <ul className="space-y-0.5">
      {items.map((i) => (
        <li key={i.to}>
          <NavLink to={i.to} end={i.end} onClick={onNavigate}
            className={({ isActive }) => cx('flex min-h-11 items-center rounded-lg px-3 text-sm font-medium',
              isActive ? 'bg-brand-700 text-white' : 'hover:bg-[var(--surface-2)]')}>
            {i.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function AppShell() {
  const { profile, isAdmin, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const { data: settings } = useQuery({ queryKey: ['public-settings'], queryFn: getPublicSettings, staleTime: 5 * 60_000 });
  const inAdmin = loc.pathname.startsWith('/admin');

  const nav = (
    <nav className="space-y-5" aria-label="Main">
      {isAdmin && (
        <div>
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Dispatch</p>
          <NavList items={adminNav} onNavigate={() => setOpen(false)} />
        </div>
      )}
      <div>
        {isAdmin && <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">My driving</p>}
        <NavList items={driverNav} onNavigate={() => setOpen(false)} />
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-full flex-col">
      {settings && settings.environment !== 'production' && (
        <div className="bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950">
          {settings.environment.toUpperCase()} — demo data may be shown. Not live business data.
        </div>
      )}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 sm:px-4">
        <button type="button" className="grid size-10 place-items-center rounded-lg hover:bg-[var(--surface-2)] lg:hidden" aria-label="Open menu"
          aria-expanded={open} onClick={() => setOpen(!open)}>☰</button>
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="font-semibold">Handy Transportation</span>
        {inAdmin && <span className="hidden rounded bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 sm:inline dark:bg-purple-900/40 dark:text-purple-200">Dispatch</span>}
        <div className="ml-auto flex items-center gap-1">
          <span className="hidden max-w-48 truncate text-sm text-[var(--muted)] sm:inline">{profile?.full_name || profile?.email}</span>
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>Log out</Button>
        </div>
      </header>
      <div className="flex flex-1">
        <aside className="hidden w-60 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] p-3 lg:block">{nav}</aside>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
            <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-[var(--surface)] p-3 shadow-xl">{nav}</div>
          </div>
        )}
        <main className={cx('min-w-0 flex-1 p-3 sm:p-5', inAdmin ? 'max-w-[110rem]' : 'mx-auto max-w-5xl')}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
