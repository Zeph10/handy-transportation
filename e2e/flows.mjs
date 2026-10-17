// End-to-end flows against the local test stack (bash e2e/start-stack.sh).
// Run: node e2e/flows.mjs [screenshotDir]
// Uses the real web app, real database, real RLS and functions.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import pg from 'pg';

const require = createRequire(import.meta.url);
let playwright;
playwright = require('playwright');

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const SHOTS = process.argv[2] ?? '/tmp/handy-e2e/shots';
mkdirSync(SHOTS, { recursive: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55440/handy' });
await db.connect();

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`ok   ${name}`); }
  catch (e) { for (const [i, p] of pages.entries()) await p.screenshot({ path: `${SHOTS}/FAIL-${i}.png` }).catch(() => {}); results.push({ name, ok: false, error: e.message }); console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); throw e; }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
/** Poll a query until check(rows) is true (UI confirmations can precede the last write by a moment). */
async function eventually(sql, params, check, msg) {
  let rows = [];
  for (let i = 0; i < 40; i++) { rows = (await db.query(sql, params)).rows; if (check(rows)) return rows; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`${msg}: ${JSON.stringify(rows).slice(0, 300)}`);
}

const browser = await playwright.chromium.launch();
const errors = [];
const pages = [];
async function newPage(viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, timezoneId: 'America/Los_Angeles' }); // prove the app ignores the device time zone
  const page = await ctx.newPage();
  pages.push(page);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|503/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return page;
}
async function login(page, email, name) {
  await page.goto(`${APP}/login`);
  await page.getByLabel(/^Email/).fill(email);
  if (name) await page.getByLabel(/Your name/).fill(name);
  await page.getByRole('button', { name: 'Email me a login link' }).click();
  await page.getByLabel('Code from email').fill('123456');
  await page.getByRole('button', { name: 'Log in with code' }).click();
}
const shot = (page, n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false });

try {
  // ------------------------------------------------------------ Criterion 1 & 2
  const driver = await newPage();
  await step('1. new driver registers and waits for approval', async () => {
    await login(driver, 'new.driver@t.test', 'Nina Newdriver');
    await driver.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
    await shot(driver, '01-pending');
  });
  await step('2. unapproved driver cannot open protected pages', async () => {
    await driver.goto(`${APP}/driver`);
    await driver.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
    await driver.goto(`${APP}/admin`);
    await driver.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
  });

  // ------------------------------------------------------------ Admin approves
  const admin = await newPage();
  await step('admin dashboard loads with live data', async () => {
    await login(admin, 'admin@demo.handy.test');
    await admin.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await admin.getByText('Drivers available by hour').waitFor();
    await shot(admin, '02-admin-dashboard');
  });
  await step('admin approves the registration', async () => {
    await admin.goto(`${APP}/admin/approvals`);
    const row = admin.getByRole('listitem').filter({ hasText: 'Nina Newdriver' });
    await row.getByRole('button', { name: 'Approve' }).click();
    await admin.getByText('Driver approved').waitFor();
    await eventually(`select status from driver_profiles where email = 'new.driver@t.test'`, [], (rows) => rows[0]?.status === 'APPROVED', 'status not approved in DB');
  });

  // ------------------------------------------------------------ Criterion 3, 4, 6, 10
  await step('3a. approved driver adds a vehicle', async () => {
    await driver.getByRole('button', { name: 'Check again' }).click();
    await driver.waitForURL(/\/driver$/);
    await driver.getByText('Start by adding your vehicle').waitFor();
    await driver.goto(`${APP}/driver/vehicles`);
    await driver.getByRole('button', { name: 'Add your first vehicle' }).click();
    await driver.getByLabel(/^Name/).fill('Black Suburban');
    await driver.getByLabel('Type').selectOption('SUV');
    await driver.getByLabel(/Max passengers/).fill('6');
    await driver.getByLabel(/Max large bags/).fill('6');
    await driver.getByRole('button', { name: 'Save' }).click();
    await driver.getByText('Vehicle saved').first().waitFor();
    await driver.getByRole('button', { name: '+ Add vehicle' }).click();
    await driver.getByLabel(/^Name/).fill('Camry');
    await driver.getByLabel(/Max passengers/).fill('3');
    await driver.getByRole('button', { name: 'Save' }).click();
    await driver.getByText('Vehicle saved').last().waitFor();
    await shot(driver, '03-vehicles');
  });
  await step('3b. driver sees preset rates and changes the JFK minimum', async () => {
    await driver.goto(`${APP}/driver/rates`);
    await driver.getByText('Company standard $210').waitFor();
    await driver.getByLabel('Minimum for JFK').fill('225');
    await driver.getByRole('button', { name: 'Save' }).click();
    await driver.getByText('Destinations and rates saved').waitFor();
    await eventually(`select d.min_rate_cents from driver_destination_defaults d join destinations x on x.id = d.destination_id join driver_profiles p on p.user_id = d.driver_id where p.email = 'new.driver@t.test' and x.code = 'JFK'`, [], (rows) => rows[0]?.min_rate_cents === 22500, 'JFK minimum not saved');
  });
  await step('3c. driver saves availability with the form (no dragging)', async () => {
    await driver.goto(`${APP}/driver`);
    await driver.getByRole('button', { name: '+ Add availability' }).click();
    await driver.getByLabel(/^Date/).fill('2026-10-21');
    await driver.getByLabel(/^From/).fill('06:00');
    await driver.getByLabel(/^Until/).fill('11:00');
    await driver.getByRole('button', { name: 'Save', exact: true }).click();
    await driver.getByText('Availability saved').last().waitFor();
  });
  await step('6+10. second block same day with different vehicle, destinations and rate', async () => {
    await driver.getByRole('button', { name: '+ Add availability' }).click();
    await driver.getByLabel(/^Date/).fill('2026-10-21');
    await driver.getByLabel(/^From/).fill('15:00');
    await driver.getByLabel(/^Until/).fill('22:00');
    const vsel = driver.getByLabel(/^Vehicle for this time/);
    await vsel.selectOption(await vsel.locator('option', { hasText: 'Camry' }).getAttribute('value'));
    await driver.getByRole('button', { name: 'Deselect all' }).click();
    await driver.getByRole('button', { name: /NYC/ }).first().click();
    await driver.getByRole('button', { name: 'Change for this block' }).click();
    await driver.getByLabel('Minimum rate for NYC').fill('175');
    await driver.getByLabel('Minimum rate for NYC').blur();
    await driver.getByRole('button', { name: 'Save', exact: true }).click();
    await driver.getByText('Availability saved').last().waitFor();
    const r = { rows: await eventually(`select b.start_at, v.name, array_agg(x.code || ':' || coalesce(d.min_rate_cents::text, 'inherit')) as dests
      from availability_blocks b join vehicles v on v.id = b.vehicle_id join availability_block_destinations d on d.block_id = b.id join destinations x on x.id = d.destination_id
      join driver_profiles p on p.user_id = b.driver_id where p.email = 'new.driver@t.test' group by b.id, v.name order by b.start_at`, [], (rows) => rows.length === 2, 'expected 2 blocks') };
    expect(r.rows[1].name === 'Camry' && r.rows[1].dests.join() === 'NYC:17500', `second block: ${JSON.stringify(r.rows[1])}`);
    expect(new Date(r.rows[0].start_at).toISOString() === '2026-10-21T10:00:00.000Z', `6 AM New York stored as ${new Date(r.rows[0].start_at).toISOString()} (browser is in Los Angeles)`);
  });
  await step('7. overnight entry: one record shown across midnight', async () => {
    await driver.getByRole('button', { name: '+ Add availability' }).click();
    await driver.getByLabel(/^Date/).fill('2026-10-23');
    await driver.getByLabel(/^From/).fill('20:00');
    await driver.getByLabel(/^Until/).fill('04:00');
    await driver.getByText(/Ends next day/).waitFor();
    await driver.getByRole('button', { name: 'Save', exact: true }).click();
    await driver.getByText('Availability saved').last().waitFor();
    await eventually(`select count(*)::int n from availability_blocks b join driver_profiles p on p.user_id = b.driver_id where p.email = 'new.driver@t.test' and b.start_at = '2026-10-24T00:00:00Z' and b.end_at = '2026-10-24T08:00:00Z'`, [], (rows) => rows[0].n === 1, 'overnight block not stored as one record');
  });
  await step('4. refresh keeps saved availability (week of Oct 19)', async () => {
    await driver.getByLabel('Go to date').fill('2026-10-21');
    await driver.reload();
    await driver.getByLabel('Go to date').fill('2026-10-21');
    await driver.locator('.fc-event').filter({ hasText: 'Camry' }).first().waitFor();
    const count = await driver.locator('.fc-event').count();
    expect(count >= 4, `expected ≥4 calendar segments (overnight split in two), got ${count}`);
    await shot(driver, '04-driver-week');
  });
  await step('8. weekly schedule repeats and a single day can be skipped', async () => {
    await driver.goto(`${APP}/driver/schedule`);
    await driver.getByRole('button', { name: '+ Add weekly time' }).click();
    await driver.getByRole('button', { name: /Sat/ }).click();
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) await driver.getByRole('button', { name: new RegExp(d) }).click();
    await driver.getByLabel(/^From/).fill('09:00');
    await driver.getByLabel(/^Until/).fill('13:00');
    await driver.getByLabel('Starting').fill('2026-10-01');
    await driver.getByRole('button', { name: 'Save' }).click();
    await driver.getByText(/Weekly schedule saved|Saved\./).waitFor();
    await driver.getByText(/^Sat · 9:00 AM – 1:00 PM/).waitFor();
    await driver.goto(`${APP}/driver`);
    await driver.getByLabel('Go to date').fill('2026-10-24');
    const ev = driver.locator('.fc-event.ev-recurring').first();
    await ev.waitFor();
    await ev.click();
    await driver.getByText('This day comes from your weekly schedule').waitFor();
    await driver.getByRole('button', { name: 'Delete' }).click();
    await driver.getByRole('button', { name: 'Remove this day only' }).click();
    await driver.getByText(/saved|sent to the dispatcher/i).first().waitFor();
    await eventually(`select (select count(*) from rule_exceptions e join availability_rules r on r.id = e.rule_id join driver_profiles p on p.user_id = r.driver_id where p.email = 'new.driver@t.test' and e.occurrence_date = '2026-10-24')
      + (select count(*) from change_requests c join driver_profiles p on p.user_id = c.driver_id where p.email = 'new.driver@t.test' and c.action = 'SKIP_OCCURRENCE') as n`, [], (rows) => Number(rows[0].n) === 1, 'skip not recorded');
  });
  await step('9. copy a block to several days in one go', async () => {
    await driver.getByLabel('Go to date').fill('2026-10-21');
    await driver.locator('.fc-event').filter({ hasText: 'Camry' }).first().click();
    await driver.getByRole('button', { name: 'Copy to other days…' }).click();
    await driver.getByRole('button', { name: /Thu 22/ }).click();
    await driver.getByRole('button', { name: /Fri 23/ }).click();
    await driver.getByRole('button', { name: /Copy to 2 days/ }).click();
    await driver.getByText(/Copied to 1 day \(1 skipped: already had availability then\)/).waitFor();
    await eventually(`select count(*)::int n from availability_blocks b join driver_profiles p on p.user_id = b.driver_id where p.email = 'new.driver@t.test' and b.origin = 'COPY' and b.start_at = '2026-10-22T19:00:00Z'`, [], (rows) => rows[0].n === 1, 'Thursday copy missing');
  });

  // ------------------------------------------------------------ Criterion 5 (UI side)
  await step('5. driver cannot reach admin pages by URL', async () => {
    await driver.goto(`${APP}/admin/reservations`);
    await driver.waitForURL(/\/driver$/);
  });

  // ------------------------------------------------------------ Reservations + matching (11, 16-22)
  await step('simulate a calendar sync with the TRP-04327-style unfilled trip', async () => {
    await db.query(`select public.store_calendar_connection((select user_id from user_roles where role = 'ADMIN' limit 1), 'support@example.test', '{}', 'test-refresh-token-xyz')`);
    await db.query(`update calendar_connections set calendar_id = 'support@example.test', calendar_name = 'Reservations'`);
    const run = (await db.query(`select public.sync_begin((select user_id from user_roles where role = 'ADMIN' limit 1)) as r`)).rows[0].r;
    await db.query(`update sync_runs set window_start = '2026-10-01', window_end = '2026-12-31' where id = $1`, [run.run_id]);
    const rows = [
      { google_event_id: 'e1', etag: '1', source_status: 'confirmed', start_at: '2026-10-21T19:00:00Z', end_at: '2026-10-21T20:00:00Z', is_reservation: true, trip_ref: 'TRP-90001', destination_code: 'NYC', passengers: 1, checked_bags: 0, assignment: 'UNFILLED', congestion: 'YES', parser_version: 1, parsed: { pickupAddress: 'Example Law @ 1 Example Plaza, NYC', dropoffAddress: '10 Sample Ridge, Oakland, NJ', rateLabel: 'New York City - Congestion', carryOnBags: 0 }, review_flags: [] },
      { google_event_id: 'e2', etag: '1', source_status: 'confirmed', start_at: '2026-10-21T19:00:00Z', end_at: '2026-10-21T20:00:00Z', is_reservation: true, trip_ref: 'TRP-90002', destination_code: 'JFK', passengers: 5, checked_bags: 5, assignment: 'UNFILLED', congestion: 'UNKNOWN', parser_version: 1, parsed: {}, review_flags: [] },
      { google_event_id: 'e3', etag: '1', source_status: 'confirmed', start_at: '2026-10-22T13:00:00Z', end_at: '2026-10-22T14:00:00Z', is_reservation: true, trip_ref: 'TRP-90003', destination_code: null, passengers: null, assignment: 'UNFILLED', congestion: 'UNKNOWN', parser_version: 1, parsed: {}, review_flags: ['UNRECOGNIZED_RATE', 'MISSING_DESTINATION', 'MISSING_PASSENGERS'] },
    ];
    await db.query(`select public.sync_apply($1, $2::jsonb)`, [run.run_id, JSON.stringify(rows)]);
    await db.query(`select public.sync_finish($1, true)`, [run.run_id]);
    await db.query(`update destinations set est_duration_minutes = 75 where code = 'NYC'`);
  });
  await step('11+16. admin sees all approved drivers and the unfilled trips', async () => {
    await admin.goto(`${APP}/admin/reservations?filter=unfilled`);
    await admin.getByText('TRP-90001').waitFor();
    await admin.getByText('TRP-90002').waitFor();
    await shot(admin, '05-reservations');
    await admin.goto(`${APP}/admin/drivers`);
    await admin.getByRole('link', { name: 'Nina Newdriver' }).waitFor();
    await admin.getByRole('link', { name: 'DEMO Dana Driver' }).waitFor();
  });
  await step('19+22. matching: partial coverage rejected, congestion shown separately', async () => {
    const id = (await db.query(`select id from reservations where google_event_id = 'e1'`)).rows[0].id;
    await admin.goto(`${APP}/admin/reservations/${id}`);
    await admin.getByText('Congestion Pricing').waitFor();
    await admin.getByText('+$9').waitFor();
    await admin.getByText('Company preset (not stated on the reservation)').waitFor();
    // Nina is available 3–10 PM with NYC at $175 minimum: covered, but $175 > $160 → not eligible with the shortfall.
    await admin.getByRole('button', { name: /Not eligible/ }).click();
    const nina = admin.getByRole('listitem').filter({ hasText: 'Nina Newdriver' });
    await nina.getByText('Minimum $175 exceeds proposed $160 (needs $15 more)').waitFor();
    // Dana's weekly schedule ends at 2 PM: not covering the trip window.
    await admin.getByRole('listitem').filter({ hasText: 'DEMO Dana Driver' }).getByText(/No availability submitted|Available only until|Not available until/).first().waitFor();
    await shot(admin, '06-matching');
  });
  await step('18. lowering the payout correction is reflected immediately', async () => {
    await admin.getByRole('button', { name: 'Correct details' }).click();
    await admin.getByLabel(/Driver payout/).fill('180');
    await admin.getByRole('button', { name: 'Save' }).click();
    await admin.getByText('Correction saved').waitFor();
    // Rate problem gone ($175 ≤ $180); the timing problem (starts 3 PM, trip needs 2 PM) remains.
    const ninaRow = admin.getByRole('listitem').filter({ hasText: 'Nina Newdriver' }).first();
    await ninaRow.getByText(/Not available until 3:00 PM/).waitFor();
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = (await ninaRow.getByText(/exceeds proposed/).count()) === 0; if (!gone) await admin.waitForTimeout(250); }
    expect(gone, 'rate reason should be gone after correction');
    await admin.getByText('Set by dispatcher').waitFor();
    await eventually(`select proposed_payout_cents from reservation_corrections c join reservations r on r.id = c.reservation_id where r.google_event_id = 'e1'`, [], (rows) => rows[0]?.proposed_payout_cents === 18000, 'correction not stored');
    const raw = await db.query(`select payout_cents from reservations where google_event_id = 'e1'`);
    expect(raw.rows[0].payout_cents === null, 'imported value was overwritten');
  });
  await step('17. insufficient capacity is rejected (5 passengers, Camry/sedan)', async () => {
    const id = (await db.query(`select id from reservations where google_event_id = 'e2'`)).rows[0].id;
    await admin.goto(`${APP}/admin/reservations/${id}`);
    await admin.getByRole('button', { name: /Not eligible/ }).click();
    await admin.getByText(/Does not accept JFK|Insufficient passenger capacity/).first().waitFor();
  });
  await step('20. missing information yields review, not guesses', async () => {
    const id = (await db.query(`select id from reservations where google_event_id = 'e3'`)).rows[0].id;
    await admin.goto(`${APP}/admin/reservations/${id}`);
    await admin.getByText(/Needs review: rate not recognized/).waitFor();
    await admin.getByText('Unknown').first().waitFor();
  });
  await step('12. admin edit is logged and visible to the driver', async () => {
    const ninaId = (await db.query(`select user_id from driver_profiles where email = 'new.driver@t.test'`)).rows[0].user_id;
    await admin.goto(`${APP}/admin/drivers/${ninaId}`);
    await admin.getByLabel('Go to date').fill('2026-10-21');
    await admin.locator('.fc-event').filter({ hasText: 'Camry' }).first().click();
    await admin.getByLabel(/^Until/).fill('21:00');
    await admin.getByLabel(/Reason for this change/).fill('Driver called: leaving early');
    await admin.getByRole('button', { name: 'Save', exact: true }).click();
    await admin.getByText('Availability saved').last().waitFor();
    await eventually(`select actor_role, reason from audit_log where action = 'BLOCK_UPDATED' and affected_driver_id = $1 order by id desc limit 1`, [ninaId],
      (rows) => rows[0]?.actor_role === 'ADMIN' && rows[0].reason === 'Driver called: leaving early', 'audit entry missing');
    await driver.goto(`${APP}/driver/changes`);
    await driver.getByText('Reason: Driver called: leaving early').waitFor();
    await shot(driver, '07-driver-sees-admin-change');
  });
  await step('master calendar shows availability and reservations together', async () => {
    await admin.goto(`${APP}/admin/calendar?date=2026-10-21`);
    await admin.getByLabel('Go to date').fill('2026-10-21');
    await admin.locator('.fc-event').filter({ hasText: 'UNFILLED' }).first().waitFor();
    await admin.locator('.fc-event').filter({ hasText: 'Nina' }).first().waitFor();
    await shot(admin, '08-master-calendar');
  });
  await step('settings save and are audited', async () => {
    await admin.goto(`${APP}/admin/settings`);
    await admin.getByLabel(/Post-trip buffer/).fill('45');
    await admin.getByRole('button', { name: 'Save settings' }).click();
    await admin.getByText('Settings saved').waitFor();
    await eventually(`select (after->>'post_trip_buffer_minutes')::int v from audit_log where entity_table = 'app_settings' order by id desc limit 1`, [], (rows) => rows[0]?.v === 45, 'settings audit missing');
  });

  // ------------------------------------------------------------ Criterion 25: mobile
  await step('25. phone layout: driver adds availability on a 390px screen', async () => {
    const phone = await newPage({ width: 390, height: 844 });
    await login(phone, 'dana@demo.handy.test');
    await phone.waitForURL(/\/driver$/);
    await phone.getByRole('button', { name: 'Day', exact: true }).waitFor();
    await shot(phone, '09-phone-day');
    await phone.getByRole('button', { name: '+ Add availability' }).click();
    await phone.getByLabel(/^Date/).fill('2026-10-25');
    await phone.getByLabel(/^From/).fill('07:00');
    await phone.getByLabel(/^Until/).fill('12:00');
    await shot(phone, '10-phone-editor');
    await phone.getByRole('button', { name: 'Save', exact: true }).click();
    await phone.getByText('Availability saved').last().waitFor();
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(!overflow, 'page scrolls horizontally on a phone');
  });
} catch {
  // reported below
} finally {
  await browser.close();
  await db.end();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nE2E: ${passed}/${results.length} steps passed`);
  if (errors.length) { console.log(`Browser errors (${errors.length}):`); [...new Set(errors)].slice(0, 15).forEach((e) => console.log('  ' + e)); }
  process.exit(passed === results.length && results.length > 0 ? 0 : 1);
}
