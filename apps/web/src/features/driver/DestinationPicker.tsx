import { formatUSD, parseDollars } from '@handy/core';
import type { DestinationOffer } from '@handy/core';
import { Button, Chip, Input } from '@/components/ui';
import { destinationColor } from '@/lib/style';
import type { DestinationDefaultRow, DestinationRow } from '@/lib/types';

/**
 * Destination chips with Select all / Deselect all, and the minimum rate for
 * each selected destination. Rates come from the driver's usual rates unless
 * overridden for this block.
 */
export function DestinationPicker({ destinations, defaults, value, onChange, congestionCents }: {
  destinations: DestinationRow[];
  defaults: DestinationDefaultRow[];
  value: DestinationOffer[];
  onChange: (v: DestinationOffer[]) => void;
  congestionCents?: number;
}) {
  const selected = new Map(value.map((v) => [v.destinationId, v]));
  const usual = (id: string) => {
    const d = defaults.find((x) => x.destination_id === id);
    return d?.min_rate_cents ?? destinations.find((x) => x.id === id)?.preset_payout_cents ?? 0;
  };
  const toggle = (id: string) => {
    if (selected.has(id)) onChange(value.filter((v) => v.destinationId !== id));
    else onChange([...value, { destinationId: id, minRateCents: null }]);
  };
  const setRate = (id: string, cents: number | null) =>
    onChange(value.map((v) => (v.destinationId === id ? { ...v, minRateCents: cents } : v)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {destinations.map((d) => (
          <Chip key={d.id} selected={selected.has(d.id)} onClick={() => toggle(d.id)} color={destinationColor(d.code)}>{d.name}</Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(destinations.map((d) => selected.get(d.id) ?? { destinationId: d.id, minRateCents: null }))}>Select all</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([])}>Deselect all</Button>
      </div>
      {value.length > 0 && (
        <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {destinations.filter((d) => selected.has(d.id)).map((d) => {
            const offer = selected.get(d.id)!;
            const overridden = offer.minRateCents !== null;
            return (
              <div key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="size-2.5 rounded-full" style={{ background: destinationColor(d.code) }} aria-hidden="true" />
                <span className="w-28 text-sm font-medium">{d.name}</span>
                {!overridden ? (
                  <>
                    <span className="text-sm">Minimum {formatUSD(usual(d.id))} <span className="text-[var(--muted)]">(your usual)</span></span>
                    <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setRate(d.id, usual(d.id))}>Change for this block</Button>
                  </>
                ) : (
                  <>
                    <label className="flex items-center gap-1 text-sm">
                      Minimum $
                      <Input aria-label={`Minimum rate for ${d.name}`} inputMode="decimal" className="h-10 w-24"
                        defaultValue={(offer.minRateCents! / 100).toString()}
                        onBlur={(e) => { const c = parseDollars(e.target.value); setRate(d.id, c ?? offer.minRateCents); if (c === null) e.target.value = (offer.minRateCents! / 100).toString(); }} />
                    </label>
                    <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setRate(d.id, null)}>Use my usual</Button>
                  </>
                )}
                {d.congestion_eligible && congestionCents ? (
                  <p className="w-full pl-5 text-xs text-[var(--muted)]">Congestion pricing: +{formatUSD(congestionCents)} paid separately when it applies.</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
