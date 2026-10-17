import { RESERVATION_STYLE, STATUS_STYLE } from '@/lib/style';

export function Legend({ reservations = false }: { reservations?: boolean }) {
  const items: { label: string; style: React.CSSProperties; className?: string }[] = [
    { label: STATUS_STYLE.AVAILABLE.label, style: { background: STATUS_STYLE.AVAILABLE.bg } },
    { label: STATUS_STYLE.TENTATIVE.label, style: { background: STATUS_STYLE.TENTATIVE.bg } },
    { label: STATUS_STYLE.UNAVAILABLE.label, style: { background: STATUS_STYLE.UNAVAILABLE.bg } },
    { label: 'Time off / marked unavailable', style: {}, className: 'pattern-unavailable border border-slate-400' },
    { label: 'Unknown: nothing submitted (blank)', style: {}, className: 'pattern-unknown border border-slate-300' },
    { label: '↻ Weekly schedule', style: { background: STATUS_STYLE.AVAILABLE.bg, opacity: 0.75 } },
  ];
  if (reservations) {
    items.push(
      { label: RESERVATION_STYLE.UNFILLED.label, style: { background: RESERVATION_STYLE.UNFILLED.bg } },
      { label: RESERVATION_STYLE.ASSIGNED.label, style: { background: RESERVATION_STYLE.ASSIGNED.bg } },
      { label: 'Other reservation / needs review', style: { background: RESERVATION_STYLE.IMPORTED.bg } },
      { label: 'Conflict', style: { background: RESERVATION_STYLE.CONFLICT.bg, outline: '2px solid #fde047' } },
    );
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]" aria-label="Colour legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className={`inline-block size-3 rounded-sm ${i.className ?? ''}`} style={i.style} aria-hidden="true" />{i.label}
        </li>
      ))}
    </ul>
  );
}
