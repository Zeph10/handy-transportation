import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { fetchMyAccount } from '@/lib/api';
import type { ProfileRow } from '@/lib/types';

interface SessionState {
  loading: boolean;
  session: Session | null;
  userId: string | null;
  profile: ProfileRow | null;
  isAdmin: boolean;
  /** Approved drivers and admins may use the app; everyone else sees the status page. */
  isApproved: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (s: Session | null) => {
    setSession(s);
    if (!s) { setProfile(null); setIsAdmin(false); setLoading(false); return; }
    try {
      const acct = await fetchMyAccount(s.user.id);
      setProfile(acct.profile);
      setIsAdmin(acct.isAdmin);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => load(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'TOKEN_REFRESHED') { setSession(s); return; }
      void load(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const value: SessionState = {
    loading,
    session,
    userId: session?.user.id ?? null,
    profile,
    isAdmin,
    isApproved: isAdmin || profile?.status === 'APPROVED',
    error,
    refresh: async () => { const { data } = await supabase.auth.getSession(); await load(data.session); },
    signOut: async () => { await supabase.auth.signOut(); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** Signed-in, approved user id (route guards guarantee this inside the app). */
export function useUserId(): string {
  const { userId } = useSession();
  if (!userId) throw new Error('Not signed in');
  return userId;
}
