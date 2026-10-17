// Small accessible UI kit in the shadcn/ui style (Tailwind, no paid or heavy dependencies).
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState,
} from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- Button
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-brand-700/50',
  secondary: 'bg-[var(--surface-2)] text-[var(--text)] hover:brightness-95 dark:hover:brightness-125',
  outline: 'border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)]',
  ghost: 'hover:bg-[var(--surface-2)]',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean;
}>(function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }, ref) {
  const sizes = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-base' };
  return (
    <button
      ref={ref}
      className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed',
        variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className ?? 'size-5')} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- Form fields
const inputCls = 'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] placeholder:text-[var(--muted)] focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/30 disabled:opacity-60';

export function Field({ label, error, help, children, htmlFor, required }: {
  label: string; error?: string | null; help?: ReactNode; children: ReactNode; htmlFor?: string; required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}{required && <span className="text-red-600" aria-hidden="true"> *</span>}
      </label>
      {children}
      {help && !error && <p className="text-xs text-[var(--muted)]">{help}</p>}
      {error && <p className="text-xs font-medium text-red-600" role="alert">{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cx(inputCls, 'h-11', className)} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cx(inputCls, 'min-h-20 py-2', className)} {...p} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...p }, ref) {
  return <select ref={ref} className={cx(inputCls, 'h-11', className)} {...p} />;
});

export function Checkbox({ label, checked, onChange, disabled, description }: {
  label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: ReactNode;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx('flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-1 py-2', disabled && 'opacity-60')}>
      <input id={id} type="checkbox" className="mt-0.5 size-5 accent-brand-700" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} />
      <span><span className="text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-[var(--muted)]">{description}</span>}</span>
    </label>
  );
}

/** Large tappable toggle chip (destinations, weekdays). */
export function Chip({ selected, onClick, children, color, disabled }: {
  selected: boolean; onClick: () => void; children: ReactNode; color?: string; disabled?: boolean;
}) {
  return (
    <button type="button" aria-pressed={selected} disabled={disabled} onClick={onClick}
      className={cx('inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors',
        selected ? 'border-transparent text-white' : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-2)]')}
      style={selected ? { background: color ?? 'var(--color-brand-700)' } : undefined}>
      <span aria-hidden="true">{selected ? '✓' : '+'}</span>{children}
    </button>
  );
}

// ---------------------------------------------------------------- Layout bits
export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5', className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ children, tone = 'gray', className }: { children: ReactNode; tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'purple'; className?: string }) {
  const tones = {
    gray: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
    amber: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
    red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
    purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200',
  };
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-[var(--muted)]">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 p-10 text-[var(--muted)]" role="status"><Spinner />{label}</div>;
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200" role="alert">
      <p className="font-medium">Couldn't load this.</p>
      <p className="mt-1">{message}</p>
      {onRetry && <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode }) {
  const t = {
    info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
    error: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100',
    success: 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100',
  };
  return <div className={cx('rounded-lg border p-3 text-sm', t[tone])} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

// ---------------------------------------------------------------- Dialog / Sheet (native <dialog>)
export function Dialog({ open, onClose, title, children, footer, variant = 'modal', wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; variant?: 'modal' | 'sheet'; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const panel = variant === 'sheet'
    ? 'fixed inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[30rem] sm:rounded-none sm:rounded-l-2xl'
    : cx('fixed left-1/2 top-1/2 max-h-[90dvh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl', wide ? 'max-w-3xl' : 'max-w-lg');
  return (
    <dialog ref={ref} className="ui-dialog" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {open && (
        <div className={cx(panel, 'flex flex-col bg-[var(--surface)] text-[var(--text)] shadow-2xl')}>
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="grid size-10 place-items-center rounded-lg hover:bg-[var(--surface-2)]" aria-label="Close">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- Confirm (promise-based)
type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; choices?: { label: string; value: string; danger?: boolean }[] };
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<string | null>>(async () => null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: string | null) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<string | null>((resolve) => setState({ ...o, resolve })), []);
  const done = (v: string | null) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog open={!!state} onClose={() => done(null)} title={state?.title ?? ''}
        footer={state && (
          <>
            <Button variant="outline" onClick={() => done(null)}>Cancel</Button>
            {state.choices
              ? state.choices.map((c) => <Button key={c.value} variant={c.danger ? 'danger' : 'primary'} onClick={() => done(c.value)}>{c.label}</Button>)
              : <Button variant={state.danger ? 'danger' : 'primary'} onClick={() => done('confirm')}>{state.confirmLabel ?? 'Confirm'}</Button>}
          </>
        )}>
        <div className="text-sm">{state?.body}</div>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

/** const confirm = useConfirm(); if (await confirm({ title: 'Delete?' })) … — resolves to the chosen value or null. */
export const useConfirm = () => useContext(ConfirmCtx);

// ---------------------------------------------------------------- Toasts (save confirmations)
type Toast = { id: number; tone: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
            className={cx('pointer-events-auto max-w-md rounded-lg px-4 py-3 text-sm font-medium shadow-lg',
              t.tone === 'success' && 'bg-green-700 text-white', t.tone === 'error' && 'bg-red-700 text-white', t.tone === 'info' && 'bg-slate-800 text-white')}>
            {t.tone === 'success' ? '✓ ' : t.tone === 'error' ? '⚠ ' : ''}{t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- Theme
export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* storage unavailable */ }
    setDark(next);
  };
  return [dark, toggle];
}

export function ThemeToggle() {
  const [dark, toggle] = useTheme();
  return (
    <button type="button" onClick={toggle} className="grid size-10 place-items-center rounded-lg hover:bg-[var(--surface-2)]"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
      {dark ? '☀' : '☾'}
    </button>
  );
}
