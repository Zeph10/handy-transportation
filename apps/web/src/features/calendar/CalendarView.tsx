import { useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
import type { DateSelectArg, EventClickArg, EventInput } from '@fullcalendar/core';
import { addDays, formatLocalDate, localToInstant, startOfWeek, todayLocal, ZONE } from '@handy/core';
import type { LocalDate } from '@handy/core';
import { Button, Input } from '@/components/ui';

export type CalView = 'week' | 'day';

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 767px)');
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** Shared navigation state: the visible date and view, with the week range derived. */
export function useCalendarNav(initial?: LocalDate) {
  const narrow = useIsNarrow();
  const [date, setDate] = useState<LocalDate>(initial ?? todayLocal());
  const [view, setView] = useState<CalView>(narrow ? 'day' : 'week');
  const from = view === 'week' ? startOfWeek(date) : date;
  const to = view === 'week' ? addDays(from, 6) : date;
  return { date, setDate, view, setView, from, to, narrow };
}

export function CalendarToolbar({ nav }: { nav: ReturnType<typeof useCalendarNav> }) {
  const step = nav.view === 'week' ? 7 : 1;
  const label = nav.view === 'week' ? `${formatLocalDate(nav.from)} – ${formatLocalDate(nav.to)}` : formatLocalDate(nav.date);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={() => nav.setDate(addDays(nav.date, -step))} aria-label={nav.view === 'week' ? 'Previous week' : 'Previous day'}>‹</Button>
        <Button variant="outline" size="sm" onClick={() => nav.setDate(todayLocal())}>Today</Button>
        <Button variant="outline" size="sm" onClick={() => nav.setDate(addDays(nav.date, step))} aria-label={nav.view === 'week' ? 'Next week' : 'Next day'}>›</Button>
      </div>
      <h2 className="min-w-40 text-base font-semibold" aria-live="polite">{label}</h2>
      <label className="sr-only" htmlFor="cal-date">Go to date</label>
      <div className="w-40"><Input id="cal-date" type="date" className="h-8 text-sm" value={nav.date} onChange={(e) => e.target.value && nav.setDate(e.target.value)} /></div>
      <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-[var(--border)]" role="group" aria-label="View">
        {(['day', 'week'] as const).map((v) => (
          <button key={v} type="button" aria-pressed={nav.view === v} onClick={() => nav.setView(v)}
            className={`h-8 px-3 text-sm font-medium ${nav.view === v ? 'bg-brand-700 text-white' : 'bg-[var(--surface)]'}`}>
            {v === 'day' ? 'Day' : 'Week'}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * FullCalendar time grid, always in America/New_York (via the Luxon plugin),
 * 24 hours, 15-minute slots. Selecting a time range or tapping an event calls back.
 */
export function CalendarView({ nav, events, onSelect, onEventClick, selectable = true, height = '75dvh' }: {
  nav: ReturnType<typeof useCalendarNav>;
  events: EventInput[];
  onSelect?: (start: number, end: number) => void;
  onEventClick?: (id: string, extendedProps: Record<string, unknown>) => void;
  selectable?: boolean;
  height?: string;
}) {
  const ref = useRef<FullCalendar>(null);
  useEffect(() => {
    const api = ref.current?.getApi();
    if (!api) return;
    api.changeView(nav.view === 'week' ? 'timeGridWeek' : 'timeGridDay');
    api.gotoDate(new Date(localToInstant(nav.date, '12:00')));
  }, [nav.view, nav.date]);

  const scrollTime = useMemo(() => '06:00:00', []);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 sm:p-2">
      <FullCalendar
        ref={ref}
        plugins={[timeGridPlugin, interactionPlugin, luxonPlugin]}
        timeZone={ZONE}
        initialView={nav.view === 'week' ? 'timeGridWeek' : 'timeGridDay'}
        initialDate={new Date(localToInstant(nav.date, '12:00'))}
        headerToolbar={false}
        firstDay={1}
        allDaySlot
        allDayText="All day"
        slotDuration="00:15:00"
        slotLabelInterval="01:00"
        snapDuration="00:15:00"
        scrollTime={scrollTime}
        nowIndicator
        height={height}
        expandRows
        selectable={selectable}
        selectMirror
        selectLongPressDelay={250}
        longPressDelay={250}
        eventLongPressDelay={400}
        unselectAuto
        events={events}
        eventOverlap
        slotEventOverlap={false}
        dayHeaderFormat={{ weekday: 'short', month: 'numeric', day: 'numeric' }}
        eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
        select={(arg: DateSelectArg) => {
          ref.current?.getApi().unselect();
          if (!arg.allDay) onSelect?.(arg.start.getTime(), arg.end.getTime());
        }}
        eventClick={(arg: EventClickArg) => {
          arg.jsEvent.preventDefault();
          if (arg.event.id) onEventClick?.(arg.event.id, arg.event.extendedProps as Record<string, unknown>);
        }}
      />
    </div>
  );
}
