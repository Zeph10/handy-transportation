import { useState } from 'react';
import { addDays, formatLocalDate, startOfWeek, todayLocal } from '@handy/core';
import { Button, Card, Field, Input, Notice, PageHeader, Select, useToast } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { toAppError } from '@/lib/errors';
import { ASSIGNMENT_COLUMNS, AVAILABILITY_COLUMNS, RATE_COLUMNS, assignmentRows, availabilityRows, driverRateRows, masterScheduleGrid, toCsv } from '@/lib/exports';
import { useAdminDataset } from './useAdminData';

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function xlsx(name: string, sheets: { title: string; header: readonly string[]; rows: string[][] }[]) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Handy Transportation';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.title.slice(0, 31));
    ws.addRow([...s.header]).font = { bold: true };
    s.rows.forEach((r) => ws.addRow(r));
    ws.columns.forEach((c) => { c.width = Math.min(40, Math.max(10, ...(c.values ?? []).map((v) => String(v ?? '').length + 2))); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  download(name, await wb.xlsx.writeBuffer(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

async function pdf(name: string, title: string, subtitle: string, header: readonly string[], rows: string[][], landscape = true) {
  const { jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'letter' });
  doc.setFontSize(14);
  doc.text(title, 40, 40);
  doc.setFontSize(9);
  doc.text(subtitle, 40, 56);
  autoTable(doc, { head: [[...header]], body: rows, startY: 68, styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: [29, 78, 216] } });
  doc.save(name);
}

const BACKUP_TABLES = [
  'driver_profiles', 'user_roles', 'vehicles', 'destinations', 'app_settings', 'driver_destination_defaults', 'availability_rules',
  'availability_rule_destinations', 'availability_blocks', 'availability_block_destinations', 'rule_exceptions', 'time_off',
  'admin_unavailability', 'schedule_templates', 'change_requests', 'admin_driver_notes', 'reservations', 'reservation_corrections',
  'reservation_markers', 'parsing_rules', 'rate_mappings', 'driver_aliases', 'sync_runs', 'eligibility_overrides',
  'notification_categories', 'notification_preferences', 'notification_deliveries', 'audit_log',
] as const;

export default function ExportsPage() {
  const toast = useToast();
  const [from, setFrom] = useState(startOfWeek(todayLocal()));
  const [days, setDays] = useState(7);
  const to = addDays(from, days - 1);
  const data = useAdminDataset(from, to);
  const [driverId, setDriverId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const ds = data.data;
  const stamp = `${from}_to_${to}`;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast('error', toAppError(e).message); } finally { setBusy(null); }
  };

  const backup = () => run('backup', async () => {
    const out: Record<string, unknown[]> = {};
    for (const t of BACKUP_TABLES) {
      const rows: unknown[] = [];
      for (let page = 0; ; page++) {
        const { data: chunk, error } = await supabase.from(t).select('*').range(page * 1000, page * 1000 + 999);
        if (error) throw error;
        rows.push(...(chunk ?? []));
        if (!chunk || chunk.length < 1000) break;
      }
      out[t] = rows;
    }
    const meta = { app: 'handy-transportation', format: 1, exported_at: new Date().toISOString(), note: 'Admin JSON export. For disaster recovery use the encrypted nightly database dump (docs/BACKUP_AND_RESTORE.md).' };
    download(`handy-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ meta, tables: out }, null, 1), 'application/json');
    toast('success', 'Export downloaded');
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Exports & backups" subtitle="Files are generated in your browser from data you can already see." />
      <Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="From" htmlFor="x-from"><Input id="x-from" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="Days" htmlFor="x-days"><Select id="x-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 7, 14, 31].map((d) => <option key={d} value={d}>{d}</option>)}</Select></Field>
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">{formatLocalDate(from)} – {formatLocalDate(to)}{data.isFetching ? ' · loading…' : ''}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Availability">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!ds} loading={busy === 'acsv'} onClick={() => run('acsv', async () => download(`availability_${stamp}.csv`, toCsv(AVAILABILITY_COLUMNS, availabilityRows(ds!, from, to)), 'text/csv'))}>CSV</Button>
            <Button variant="outline" disabled={!ds} loading={busy === 'axlsx'} onClick={() => run('axlsx', () => xlsx(`availability_${stamp}.xlsx`, [{ title: 'Availability', header: AVAILABILITY_COLUMNS, rows: availabilityRows(ds!, from, to) }]))}>Excel</Button>
          </div>
        </Card>
        <Card title="Weekly master schedule">
          <p className="mb-2 text-sm text-[var(--muted)]">Week starting {formatLocalDate(startOfWeek(from))}; (T) = tentative.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!ds} loading={busy === 'mxlsx'} onClick={() => run('mxlsx', async () => { const g = masterScheduleGrid(ds!, startOfWeek(from)); await xlsx(`master_${startOfWeek(from)}.xlsx`, [{ title: 'Master schedule', header: g.header, rows: g.rows }]); })}>Excel</Button>
            <Button variant="outline" disabled={!ds} loading={busy === 'mpdf'} onClick={() => run('mpdf', async () => { const g = masterScheduleGrid(ds!, startOfWeek(from)); await pdf(`master_${startOfWeek(from)}.pdf`, 'Weekly master schedule', `Week of ${formatLocalDate(startOfWeek(from))} · America/New_York`, g.header, g.rows); })}>PDF</Button>
          </div>
        </Card>
        <Card title="Individual driver schedule (PDF)">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Driver" htmlFor="x-driver"><Select id="x-driver" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">Choose…</option>{(ds?.drivers ?? []).filter((d) => d.status === 'APPROVED').map((d) => <option key={d.user_id} value={d.user_id}>{d.full_name || d.email}</option>)}
            </Select></Field>
            <Button variant="outline" disabled={!ds || !driverId} loading={busy === 'dpdf'} onClick={() => run('dpdf', async () => {
              const d = ds!.drivers.find((x) => x.user_id === driverId)!;
              await pdf(`schedule_${(d.full_name || 'driver').replace(/\W+/g, '_')}_${stamp}.pdf`, `Schedule: ${d.full_name || d.email}`, `${formatLocalDate(from)} – ${formatLocalDate(to)} · America/New_York`,
                AVAILABILITY_COLUMNS.slice(1), availabilityRows(ds!, from, to, [driverId]).map((r) => r.slice(1)));
            })}>Download PDF</Button>
          </div>
        </Card>
        <Card title="Assignments and rates">
          <p className="mb-2 text-sm text-[var(--muted)]">Assignments exactly as known from Google Calendar or set by an admin. Unknown values stay "UNKNOWN".</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!ds} loading={busy === 'rcsv'} onClick={() => run('rcsv', async () => download(`assignments_${stamp}.csv`, toCsv(ASSIGNMENT_COLUMNS, assignmentRows(ds!, from, to)), 'text/csv'))}>Assignments CSV</Button>
            <Button variant="outline" disabled={!ds} loading={busy === 'rxlsx'} onClick={() => run('rxlsx', () => xlsx(`assignments_rates_${stamp}.xlsx`, [
              { title: 'Assignments', header: ASSIGNMENT_COLUMNS, rows: assignmentRows(ds!, from, to) },
              { title: 'Driver rates', header: RATE_COLUMNS, rows: driverRateRows(ds!) },
            ]))}>Excel (assignments + driver rates)</Button>
          </div>
        </Card>
      </div>
      <Card title="Full data export (JSON)">
        <Notice>The restorable backup is the encrypted nightly database dump made by GitHub Actions (see docs/BACKUP_AND_RESTORE.md). The Supabase Free plan has no automatic backups of its own. This JSON export is an extra copy for records.</Notice>
        <Button className="mt-3" variant="outline" loading={busy === 'backup'} onClick={() => void backup()}>Download JSON export</Button>
      </Card>
    </div>
  );
}
