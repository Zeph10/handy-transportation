import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';
import { Button, Card, Field, Input, Notice, ThemeToggle } from '@/components/ui';
import { useSession } from './session';

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id?: string) => void };
  }
}

/** Cloudflare Turnstile bot check (free). Skipped when no site key is configured (local development). */
function useTurnstile(container: React.RefObject<HTMLDivElement | null>) {
  const [token, setToken] = useState<string | null>(SITE_KEY ? null : 'dev');
  const widget = useRef<string | null>(null);
  useEffect(() => {
    if (!SITE_KEY || !container.current) return;
    const render = () => {
      if (!window.turnstile || !container.current || widget.current) return;
      widget.current = window.turnstile.render(container.current, {
        sitekey: SITE_KEY, callback: (t: string) => setToken(t), 'expired-callback': () => setToken(null), theme: 'auto',
      });
    };
    if (window.turnstile) { render(); return; }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [container]);
  const reset = () => { if (SITE_KEY && window.turnstile) { window.turnstile.reset(widget.current ?? undefined); setToken(null); } };
  return { token, reset };
}

export function LoginPage() {
  const { session, loading } = useSession();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captchaBox = useRef<HTMLDivElement>(null);
  const { token, reset } = useTurnstile(captchaBox);

  if (!loading && session) return <Navigate to="/" replace />;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const addr = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { setError('Enter a valid email address.'); return; }
    if (!token) { setError('Please complete the check above the button.'); return; }
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: addr,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: true,
        captchaToken: SITE_KEY ? token : undefined,
        data: name.trim() ? { full_name: name.trim() } : undefined,
      },
    });
    setBusy(false);
    reset();
    if (err) {
      setError(/rate|security purposes/i.test(err.message) ? 'Too many requests. Wait a minute and try again.' : toAppError(err).message);
      return;
    }
    setSentTo(addr);
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!sentTo) return;
    setBusy(true);
    const { error: err } = await supabase.auth.verifyOtp({ email: sentTo, token: code.trim(), type: 'email' });
    setBusy(false);
    if (err) setError('That code did not work. Check it or request a new link.');
  };

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-9" />
          <div>
            <p className="font-semibold leading-tight">Handy Transportation</p>
            <p className="text-xs text-[var(--muted)]">Driver availability</p>
          </div>
        </div>
        <ThemeToggle />
      </div>
      <Card>
        {!sentTo ? (
          <form onSubmit={send} className="space-y-4" noValidate>
            <div>
              <h1 className="text-lg font-semibold">Log in or join</h1>
              <p className="mt-1 text-sm text-[var(--muted)]">We email you a link. No password needed. New drivers are reviewed by the dispatcher before they can use the site.</p>
            </div>
            <Field label="Email" htmlFor="email" required>
              <Input id="email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Your name (new drivers)" htmlFor="name" help="Only needed the first time.">
              <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {SITE_KEY && <div ref={captchaBox} className="min-h-16" />}
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>Email me a login link</Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            <h1 className="text-lg font-semibold">Check your email</h1>
            <p className="text-sm">We sent a login link to <strong>{sentTo}</strong>. Open it on this device. It works once and expires in an hour.</p>
            <p className="text-sm text-[var(--muted)]">Opened the email on a different device? Enter the 6-digit code from the email here instead.</p>
            <Field label="Code from email" htmlFor="code">
              <Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" size="lg" className="w-full" loading={busy} disabled={code.length !== 6}>Log in with code</Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => { setSentTo(null); setCode(''); setError(null); }}>Use a different email</Button>
          </form>
        )}
      </Card>
    </div>
  );
}

export function AuthCallbackPage() {
  const { session, loading } = useSession();
  const [timedOut, setTimedOut] = useState(false);
  const params = new URLSearchParams(window.location.search);
  const errorDescription = params.get('error_description');
  useEffect(() => { const t = setTimeout(() => setTimedOut(true), 8000); return () => clearTimeout(t); }, []);
  if (session) return <Navigate to="/" replace />;
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      {errorDescription || (timedOut && !loading) ? (
        <Card>
          <Notice tone="error">{errorDescription ?? 'This login link has expired or was already used.'}</Notice>
          <a href="/login" className="mt-4 inline-block text-sm font-medium text-brand-700 underline">Request a new link</a>
        </Card>
      ) : (
        <p className="text-center text-[var(--muted)]" role="status">Logging you in…</p>
      )}
    </div>
  );
}

export function PendingPage() {
  const { profile, signOut, refresh } = useSession();
  const status = profile?.status ?? 'PENDING_APPROVAL';
  const text = {
    PENDING_APPROVAL: { title: 'Waiting for approval', body: 'Thanks for signing up. The dispatcher will review your account. You will be able to log in and share your availability once it is approved.' },
    REJECTED: { title: 'Account not approved', body: 'This account was not approved. Contact Handy Transportation if you think this is a mistake.' },
    SUSPENDED: { title: 'Account paused', body: 'Your account is paused. Contact Handy Transportation for details.' },
    APPROVED: { title: 'Approved', body: 'Your account is approved.' },
  }[status];
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <h1 className="text-lg font-semibold">{text.title}</h1>
        <p className="mt-2 text-sm">{text.body}</p>
        {profile?.status_reason && status !== 'PENDING_APPROVAL' && <p className="mt-2 text-sm text-[var(--muted)]">Note: {profile.status_reason}</p>}
        <p className="mt-3 text-xs text-[var(--muted)]">Signed in as {profile?.email}</p>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" onClick={() => void refresh()}>Check again</Button>
          <Button variant="ghost" onClick={() => void signOut()}>Log out</Button>
        </div>
      </Card>
    </div>
  );
}
