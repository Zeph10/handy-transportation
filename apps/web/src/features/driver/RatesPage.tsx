import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUSD, parseDollars } from '@handy/core';
import { Button, Card, Checkbox, ErrorNotice, Input, Loading, Notice, PageHeader, useToast } from '@/components/ui';
import { getPublicSettings, saveDestinationDefaults } from '@/lib/api';
import { toAppError } from '@/lib/errors';
import { destinationColor } from '@/lib/style';
import { useUserId } from '@/features/auth/session';
import { qk, useDriverReference } from './hooks';

/** Usual destinations and minimum rates; they pre-fill every new availability block. */
export function RatesPage() {
  const driverId = useUserId();
  const ref = useDriverReference(driverId);
  const settings = useQuery({ queryKey: ['public-settings'], queryFn: getPublicSettings });
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState<Record<string, { accepted: boolean; rate: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next: Record<string, { accepted: boolean; rate: string }> = {};
    for (const d of ref.destinations) {
      const def = ref.defaults.find((x) => x.destination_id === d.id);
      next[d.id] = { accepted: def?.accepted ?? false, rate: ((def?.min_rate_cents ?? d.preset_payout_cents) / 100).toString() };
    }
    setRows(next);
  }, [ref.destinations, ref.defaults]);

  const save = async () => {
    setError(null);
    const items: { destination_id: string; accepted: boolean; min_rate_cents: number | null }[] = [];
    for (const d of ref.destinations) {
      const r = rows[d.id];
      if (!r) continue;
      const cents = parseDollars(r.rate);
      if (cents === null) { setError(`Enter a valid amount for ${d.name}.`); return; }
      items.push({ destination_id: d.id, accepted: r.accepted, min_rate_cents: cents });
    }
    setBusy(true);
    try {
      await saveDestinationDefaults(items);
      toast('success', 'Destinations and rates saved');
      await qc.invalidateQueries({ queryKey: qk.defaults(driverId) });
    } catch (e) { setError(toAppError(e).message); }
    finally { setBusy(false); }
  };

  if (ref.loading) return <Loading />;
  if (ref.error) return <ErrorNotice error={ref.error} />;
  const allOn = ref.destinations.every((d) => rows[d.id]?.accepted);

  return (
    <div>
      <PageHeader title="Destinations & rates" subtitle="Your usual choices. They fill in automatically when you add availability, and you can change them for any single block." />
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm text-[var(--muted)]">Minimum = the lowest driver payout you'll accept for that destination. Company standard shown for reference.</p>
          <Button variant="outline" size="sm" onClick={() => setRows(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { ...v, accepted: !allOn }])))}>
            {allOn ? 'Deselect all' : 'Select all'}
          </Button>
        </div>
        <ul className="divide-y divide-[var(--border)]">
          {ref.destinations.map((d) => {
            const r = rows[d.id] ?? { accepted: false, rate: '' };
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="size-3 rounded-full" style={{ background: destinationColor(d.code) }} aria-hidden="true" />
                <div className="min-w-40 flex-1">
                  <Checkbox label={d.name} checked={r.accepted} onChange={(v) => setRows({ ...rows, [d.id]: { ...r, accepted: v } })}
                    description={d.preset_payout_cents > 0 ? `Company standard ${formatUSD(d.preset_payout_cents)}` : 'Rate varies by trip'} />
                  {d.congestion_eligible && settings.data && (
                    <p className="ml-8 text-xs text-[var(--muted)]">Congestion Pricing: +{formatUSD(settings.data.congestion_surcharge_cents)} when applicable, paid on top.</p>
                  )}
                </div>
                <label className="flex items-center gap-1 text-sm">
                  Minimum $
                  <Input aria-label={`Minimum for ${d.name}`} inputMode="decimal" className="h-10 w-24" value={r.rate} disabled={!r.accepted}
                    onChange={(e) => setRows({ ...rows, [d.id]: { ...r, rate: e.target.value } })} />
                </label>
              </li>
            );
          })}
        </ul>
        {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
        <Button className="mt-4" onClick={() => void save()} loading={busy}>Save</Button>
      </Card>
    </div>
  );
}
