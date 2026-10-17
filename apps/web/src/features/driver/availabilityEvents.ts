import { addDays } from '@handy/core';
import type { DriverSchedule } from '@/lib/convert';
import { occurrencesFor } from '@/lib/convert';
import type { EventInput } from '@fullcalendar/core';
import { STATUS_STYLE } from '@/lib/style';
import type { DestinationRow, VehicleRow } from '@/lib/types';
import type { LocalDate } from '@handy/core';

/** Calendar events for one driver's own view. */
export function driverEvents(s: DriverSchedule, from: LocalDate, to: LocalDate, ctx: {
  vehicles: VehicleRow[];
  destinations: DestinationRow[];
  pendingTargets: Set<string>;
  adminBlockIds?: Set<string>;
  prefix?: string; // admin calendar: driver name
  idPrefix?: string;
}): EventInput[] {
  const vName = (id: string | null) => ctx.vehicles.find((v) => v.id === id)?.name ?? '';
  const dNames = (ids: string[]) => ids.map((id) => ctx.destinations.find((d) => d.id === id)?.code ?? '?').join(', ');
  const title = (status: keyof typeof STATUS_STYLE, vehicle: string | null, dests: string[]) =>
    [ctx.prefix, STATUS_STYLE[status].label, status !== 'UNAVAILABLE' ? vName(vehicle) : null, status !== 'UNAVAILABLE' ? dNames(dests) : null]
      .filter(Boolean).join(' · ');
  const p = ctx.idPrefix ?? '';
  const events: EventInput[] = [];

  for (const b of s.blocks) {
    events.push({
      id: `${p}block:${b.id}`,
      start: b.start,
      end: b.end,
      title: title(b.status, b.vehicleId, b.destinations.map((d) => d.destinationId)),
      backgroundColor: STATUS_STYLE[b.status].bg,
      borderColor: STATUS_STYLE[b.status].bg,
      textColor: STATUS_STYLE[b.status].fg,
      classNames: [ctx.pendingTargets.has(b.id) ? 'ev-pending' : '', ctx.adminBlockIds?.has(b.id) ? 'ev-admin' : ''].filter(Boolean),
      extendedProps: { kind: 'block', blockId: b.id, driverId: b.driverId },
    });
  }
  for (const o of occurrencesFor(s, from, to)) {
    events.push({
      id: `${p}occ:${o.ruleId}:${o.occurrenceDate}`,
      start: o.start,
      end: o.end,
      title: title(o.status, o.vehicleId, o.destinations.map((d) => d.destinationId)),
      backgroundColor: STATUS_STYLE[o.status].bg,
      borderColor: STATUS_STYLE[o.status].bg,
      textColor: STATUS_STYLE[o.status].fg,
      classNames: ['ev-recurring', ctx.pendingTargets.has(o.ruleId) ? 'ev-pending' : ''].filter(Boolean),
      extendedProps: { kind: 'occurrence', ruleId: o.ruleId, occurrenceDate: o.occurrenceDate, driverId: s.rules.find((r) => r.id === o.ruleId)?.driverId },
    });
  }
  for (const t of s.timeOff) {
    events.push({
      id: `${p}timeoff:${t.id}`,
      start: t.startDate,
      end: addDays(t.endDate, 1),
      allDay: true,
      title: `${ctx.prefix ? ctx.prefix + ' · ' : ''}Time off${t.note ? `: ${t.note}` : ''}`,
      backgroundColor: '#64748b',
      borderColor: '#64748b',
      extendedProps: { kind: 'timeoff', timeOffId: t.id },
    });
  }
  for (const a of s.adminUnavailable) {
    events.push({
      id: `${p}adminu:${a.id}`,
      start: a.start,
      end: a.end,
      display: 'background',
      classNames: ['pattern-unavailable'],
      title: 'Marked unavailable by dispatcher',
      extendedProps: { kind: 'adminUnavailable', id: a.id },
    });
    events.push({
      id: `${p}adminu-label:${a.id}`,
      start: a.start,
      end: a.end,
      title: `${ctx.prefix ? ctx.prefix + ' · ' : ''}Marked unavailable by dispatcher${a.reason ? `: ${a.reason}` : ''}`,
      backgroundColor: '#334155',
      borderColor: '#7c3aed',
      extendedProps: { kind: 'adminUnavailable', id: a.id, driverId: a.driverId },
    });
  }
  return events;
}
