# Admin guide

Everything here is for the dispatcher. Drivers never see reservations, other drivers, rates of others, or your notes.

## Daily routine

1. **Dashboard**: check unfilled trips, trips with no eligible driver, items needing review, conflicts and approvals. Every tile links to the right screen.
2. Press **Sync now** (top of Dashboard, Calendar and Reservations) to pull the latest reservations from Google Calendar. The time of the last successful sync is always shown; a yellow or red banner means the data may be out of date.
3. Open an unfilled trip to see who fits.

## Reading the eligibility list

For a trip, the app works out the time a driver is needed: **pickup − travel allowance** through **pickup + trip duration + post-trip buffer** (set in Settings). A driver must be available for that whole time, not just at pickup.

| Group | Meaning |
| --- | --- |
| Eligible | Available the whole time, takes the destination, vehicle big enough, minimum within the payout, no clashing trip |
| Tentative | Same, but the driver marked some of that time "Tentative": call before relying on them |
| Review required | Something needed is unknown (destination, passengers, payout, trip duration) |
| Overridden | You overrode a problem; the original reasons stay visible |
| Not eligible | Every reason is listed, e.g. "Available only until 4:00 PM", "Minimum $175 exceeds proposed $160 (needs $15 more)" |

The payout box shows the base payout and, for NYC, **Congestion Pricing: +$9** on its own line. When the reservation has no payout, the company preset is used and labelled "assumed preset" (switch this off in Settings to get Review required instead). Drivers' minimums are compared with the base amount.

Assigning still happens the usual way in Google Calendar. After the next sync the trip shows as assigned and blocks that driver's time in matching.

## Fixing what the parser got wrong

On a reservation, **Correct details** lets you set destination, passengers, payout, congestion (applies / doesn't / not determined), trip duration, or the assignment. Corrections live only in this app; the imported values are kept and Google Calendar is never touched. **Remove all corrections** returns to imported values.

If a driver's name in the calendar doesn't match their profile, add it under **Settings → Driver name aliases**.

## Master calendar

All drivers on one calendar with reservations on top. Filter by driver, destination, status and minimum seats; toggle layers. Tap a block to edit it (you must give a reason, which is logged and shown to the driver). Select a time range to **mark a driver unavailable** without touching their own entries.

## Approvals

- **New registrations**: approve or reject. Approval copies the company rates in as the driver's starting minimums.
- **Short-notice changes**: drivers reducing availability inside the window. Nothing changes until you approve.

Suspend or reactivate a driver from their page.

## Settings

Travel allowance, post-trip buffer, congestion amount, short-notice window, submission deadline and reminder time, destinations (company payouts and **estimated trip durations**: trips without a duration show as Review required), parsing rules and rate mappings, aliases, notifications.

## Exports

Availability (CSV/Excel), weekly master schedule (Excel/PDF), individual driver schedule (PDF), assignments and rates (CSV/Excel), full JSON export. Assignments appear only as known from Google Calendar or set by you.

## Backups

See docs/BACKUP_AND_RESTORE.md. On the free plan, the nightly GitHub backup is the only automatic backup.
