import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { validateProfile } from '@handy/core';
import { Button, Card, Checkbox, Field, Input, Notice, PageHeader, Textarea, useToast } from '@/components/ui';
import { listNotificationCategories, listNotificationPrefs, setNotificationPref, updateMyProfile } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { useSession, useUserId } from '@/features/auth/session';

export function ProfilePage() {
  const userId = useUserId();
  const { profile, refresh } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const cats = useQuery({ queryKey: ['notif-cats'], queryFn: listNotificationCategories });
  const prefs = useQuery({ queryKey: ['notif-prefs', userId], queryFn: () => listNotificationPrefs(userId) });

  useEffect(() => {
    if (!profile) return;
    setName(profile.full_name); setPhone(profile.phone ?? ''); setNotes(profile.driver_notes ?? '');
  }, [profile]);

  const save = async () => {
    const errs = validateProfile({ fullName: name, phone: phone || null, driverNotes: notes || null });
    setErrors(Object.fromEntries(errs.map((e) => [e.field, e.message])));
    if (errs.length || !profile) return;
    setBusy(true);
    try {
      await updateMyProfile({ fullName: name.trim(), phone: phone.trim() || null, driverNotes: notes.trim() || null, version: profile.version });
      toast('success', 'Profile saved');
      await refresh();
    } catch (e) { setErrors({ form: toAppError(e).message }); }
    finally { setBusy(false); }
  };

  const toggle = async (code: string, enabled: boolean) => {
    try { await setNotificationPref(code, enabled); await qc.invalidateQueries({ queryKey: ['notif-prefs', userId] }); toast('success', 'Email preference saved'); }
    catch (e) { toast('error', toAppError(e).message); }
  };

  const available = (cats.data ?? []).filter((c) => c.enabled_globally);
  return (
    <div className="space-y-4">
      <PageHeader title="Profile" />
      <Card title="Your details">
        <div className="space-y-4">
          <Field label="Full name" htmlFor="p-name" required error={errors.fullName}><Input id="p-name" autoComplete="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email" htmlFor="p-email" help="Your login. Contact the dispatcher to change it."><Input id="p-email" value={profile?.email ?? ''} disabled /></Field>
          <Field label="Phone (optional)" htmlFor="p-phone" error={errors.phone}><Input id="p-phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Notes (optional)" htmlFor="p-notes" help="Anything the dispatcher should know, e.g. preferred areas."><Textarea id="p-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></Field>
          {errors.form && <Notice tone="error">{errors.form}</Notice>}
          <Button onClick={() => void save()} loading={busy}>Save</Button>
        </div>
      </Card>
      <Card title="Email reminders">
        {available.length === 0 ? <p className="text-sm text-[var(--muted)]">No email reminders are turned on right now.</p> : available.map((c) => {
          const pref = prefs.data?.find((p) => p.category === c.code);
          return <Checkbox key={c.code} label={c.description} checked={pref ? pref.enabled : c.default_on} onChange={(v) => void toggle(c.code, v)} />;
        })}
      </Card>
    </div>
  );
}
