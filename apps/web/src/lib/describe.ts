// Plain-English descriptions of change requests and audit entries. Pure (unit-tested).
import { formatDayTime, formatLocalDate, formatTime, instantToLocalDate } from '../../../../core/src/index.ts';

type Json = Record<string, unknown> | null | undefined;

const STATUS: Record<string, string> = { AVAILABLE: 'Available', TENTATIVE: 'Tentative', UNAVAILABLE: 'Unavailable' };

function span(o: Json): string {
  if (!o || !o.start_at || !o.end_at) return '';
  const s = Date.parse(String(o.start_at));
  const e = Date.parse(String(o.end_at));
  const sameDay = instantToLocalDate(s) === instantToLocalDate(e - 1);
  return sameDay ? `${formatDayTime(s)}–${formatTime(e)}` : `${formatDayTime(s)} – ${formatDayTime(e)}`;
}

export function describeRequest(r: { action: string; prior: Json; proposed: Json }): string {
  switch (r.action) {
    case 'ADD_BLOCK': return `Add ${STATUS[String(r.proposed?.status)] ?? ''} ${span(r.proposed)}`.replace(/\s+/g, ' ').trim();
    case 'UPDATE_BLOCK': return `Change ${span(r.prior)} → ${span(r.proposed)}${r.proposed?.status !== r.prior?.status ? ` (${STATUS[String(r.proposed?.status)]})` : ''}`;
    case 'DELETE_BLOCK': return `Remove ${STATUS[String(r.prior?.status)] ?? ''} ${span(r.prior)}`.replace(/\s+/g, ' ').trim();
    case 'ADD_TIME_OFF': {
      const s = String(r.proposed?.start_date ?? '');
      const e = String(r.proposed?.end_date ?? '');
      return `Time off ${s ? formatLocalDate(s) : ''}${e && e !== s ? ` – ${formatLocalDate(e)}` : ''}`;
    }
    case 'SKIP_OCCURRENCE': return `Skip weekly schedule on ${r.proposed?.occurrence_date ? formatLocalDate(String(r.proposed.occurrence_date)) : '?'}`;
    default: return r.action;
  }
}

export function describeChange(a: { action: string; entity_table: string; before: Json; after: Json }): string {
  switch (a.action) {
    case 'BLOCK_CREATED': return `Added ${STATUS[String(a.after?.status)] ?? ''} ${span(a.after)}`.replace(/\s+/g, ' ').trim();
    case 'BLOCK_UPDATED': return `Changed ${span(a.before)} → ${span(a.after)}${a.after?.status !== a.before?.status ? ` (now ${STATUS[String(a.after?.status)]})` : ''}`;
    case 'BLOCK_DELETED': return `Removed ${span(a.before)}`;
    case 'RULE_CREATED': case 'RULE_UPDATED': case 'RULE_SPLIT': case 'RULE_ENDED': return 'Changed your weekly schedule';
    case 'OCCURRENCE_SKIPPED': return `Removed weekly schedule on ${a.after?.occurrence_date ? formatLocalDate(String(a.after.occurrence_date)) : '?'}`;
    case 'insert':
      if (a.entity_table === 'admin_unavailability') return `Marked you unavailable ${span(a.after)}`;
      if (a.entity_table === 'time_off') return 'Added time off';
      return 'Added a record';
    case 'update':
      if (a.entity_table === 'admin_unavailability' && a.after?.deleted_at) return `Cleared "unavailable" for ${span(a.after)}`;
      if (a.entity_table === 'change_requests') return `Decided your request: ${String(a.after?.status ?? '').toLowerCase()}`;
      return 'Updated a record';
    default: return a.action.replace(/_/g, ' ').toLowerCase();
  }
}
