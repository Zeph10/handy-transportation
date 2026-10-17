# Design decisions

The full reasoning is in the Phase 0 plan doc; this is the short version that lives with the code.

## Scheduling model

- **Three sources**: weekly rules (wall-clock times + weekdays + effective dates), date-specific blocks (real instants), time off (whole local days). Admin "mark unavailable" is a fourth, top layer.
- **Resolution per instant**: admin unavailable → time off → date-specific block → weekly occurrence → UNKNOWN. Implemented once in `core/src/resolver.ts`.
- **Overnight**: one record, split only for display (`splitAtMidnight`). Nothing to orphan.
- **No generated rows**: weekly rules expand on demand for the requested date range only.
- **DST**: nonexistent local times move forward by the gap (02:30 → 03:30, same as Postgres); ambiguous times take the first occurrence (EDT). Recurrence is wall-clock: a Saturday 6 PM–4 AM shift is 11 real hours on fall-back night and 9 on spring-forward night.
- **Editing a weekly schedule** never rewrites the past or the short-notice window: the old series ends the day before the cutoff and the edited one starts on it. Exceptions after the cutoff move to the new series.

## Security

- RLS on every table; drivers can SELECT only their own rows once APPROVED; pending/rejected/suspended users can read only their own profile.
- Drivers have **no table write privileges**. All mutations are `SECURITY DEFINER` functions that use `auth.uid()` (any `driver_id` in a payload is ignored), validate, check `version` (optimistic concurrency) and write the audit entry in the same transaction.
- Admins edit configuration tables directly (RLS-checked); triggers audit them. The audit log is append-only and redacts token-like keys.
- Reservation tables have admin-only policies; `reservations_effective` is a `security_invoker` view so the same policies apply.
- The Google refresh token lives in Supabase Vault; only service-role functions can read it. The column pointing to it is not selectable by clients.

## Short-notice window

A driver change needs approval only when it **reduces** availability and touches the window: deleting or shortening a block, making it tentative/unavailable, dropping a destination, raising a minimum, switching to a smaller vehicle, adding unavailable/tentative time over a weekly schedule, skipping a weekly day, or adding time off. Additions apply immediately. The confirmed record is never changed while a request is pending, and only one request per item can be pending.

## Matching

`core/src/matching.ts`. Required window = pickup − travel allowance … pickup + duration + buffer. All checks run for every driver so every reason is shown. Unknown → REVIEW; tentative → TENTATIVE; override → OVERRIDDEN; none of these is ever ELIGIBLE. Minimum compared with the base payout; congestion is a separate pass-through line. Durations are admin estimates (never fabricated); the event's own end time is ignored because the booking system always writes one-hour events.

## Parsing

Configurable rules stored in the database (`parsing_rules`, `rate_mappings`, `reservation_markers`), defaulting to the booking system's labelled lines. A missing `Driver:` line means unfilled, but only after the event is identified as a reservation. Driver names match by name, alias, or invite email.

## Dependencies

`core/` and the Edge Functions have zero npm dependencies (Intl time zones, fetch), so the exact same logic runs in the browser and in Deno with nothing to install. Validation is hand-written in `core/src/validation.ts` and repeated in SQL, instead of Zod.
