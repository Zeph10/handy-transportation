// Weekly availability reminder (optional for drivers).
// Invoked hourly by pg_cron with the CRON_SECRET header; sends only during the
// configured reminder hour, once per driver per week, within the daily email cap.
// POST { "force": true } with an admin JWT sends now (for testing from Settings).
import { AppError, env, handleError, json, requireAdmin, rpc } from '../_shared/http.ts';

const DAILY_CAP = 90; // Resend free tier: 100/day; leave room for magic links.

function isoWeekKey(d = new Date()): string {
  const ny = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const t = new Date(Date.UTC(ny.getFullYear(), ny.getMonth(), ny.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function reminderEmail(name: string, hasNextWeek: boolean): { subject: string; html: string; text: string } {
  const app = env('APP_URL').replace(/\/$/, '');
  const first = name.split(' ')[0] || 'there';
  const lead = hasNextWeek
    ? 'Thanks for already sharing some availability for next week. If anything has changed, you can update it any time.'
    : 'If you would like to be considered for trips next week, you can share when you are available. This is optional.';
  const text = `Hi ${first},\n\n${lead}\n\nOpen your schedule: ${app}/driver\n\nYou can turn these reminders off in your profile.\n\nHandy Transportation`;
  const html = `<p>Hi ${escapeHtml(first)},</p><p>${escapeHtml(lead)}</p>
<p><a href="${app}/driver" style="display:inline-block;padding:10px 16px;background:#1d4ed8;color:#fff;border-radius:6px;text-decoration:none">Open my schedule</a></p>
<p style="color:#666;font-size:13px">You can turn these reminders off in your profile.</p><p>Handy Transportation</p>`;
  return { subject: 'Next week: share your availability (optional)', html, text };
}

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<string> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('EMAIL_FROM'), to: [to], subject, html, text }),
  });
  const body = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok || !body.id) throw new Error(`Resend ${res.status}: ${body.message ?? 'send failed'}`);
  return body.id;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(req, 405, { error: 'METHOD', message: 'Use POST.' });
  try {
    let force = false;
    const cron = req.headers.get('x-cron-secret');
    if (cron) {
      if (cron !== env('CRON_SECRET')) throw new AppError('FORBIDDEN', 'Bad cron secret.', 403);
    } else {
      await requireAdmin(req);
      force = ((await req.json().catch(() => ({}))) as { force?: boolean }).force === true;
    }
    if (!force && !(await rpc<boolean>('notifications_reminder_due', {}, 'service'))) {
      return json(req, 200, { ok: true, skipped: 'not the reminder hour' });
    }
    const week = isoWeekKey();
    const candidates = await rpc<{ user_id: string; email: string; full_name: string; has_next_week: boolean }[]>(
      'notifications_weekly_candidates', { p_week_key: week }, 'service');
    let sentToday = await rpc<number>('notifications_sent_today', {}, 'service');
    let sent = 0, failed = 0, deferred = 0;
    for (const c of candidates) {
      if (sentToday >= DAILY_CAP) { deferred++; continue; } // next hourly run continues tomorrow's budget
      const key = `WEEKLY_REMINDER:${week}:${c.user_id}`;
      const email = reminderEmail(c.full_name, c.has_next_week);
      try {
        const id = await sendEmail(c.email, email.subject, email.html, email.text);
        await rpc('notification_record', { p_user: c.user_id, p_category: 'WEEKLY_REMINDER', p_key: key, p_status: 'SENT', p_provider_id: id }, 'service');
        sent++; sentToday++;
      } catch (e) {
        await rpc('notification_record', { p_user: c.user_id, p_category: 'WEEKLY_REMINDER', p_key: key, p_status: 'FAILED', p_error: String(e) }, 'service');
        failed++;
      }
      await new Promise((r) => setTimeout(r, 250)); // stay well under the provider's rate limit
    }
    return json(req, 200, { ok: true, week, sent, failed, deferred });
  } catch (e) {
    return handleError(req, e);
  }
});
