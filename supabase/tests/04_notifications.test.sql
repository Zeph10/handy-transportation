-- Weekly reminder: opt-out respected, once per week, other categories off by default.
select set_config('t.a', tests.new_user('n1@t.test')::text, false);
select set_config('t.b', tests.new_user('n2@t.test')::text, false);
select set_config('t.p', tests.new_user('n3@t.test')::text, false);
update public.driver_profiles set status = 'APPROVED' where user_id in (current_setting('t.a')::uuid, current_setting('t.b')::uuid);

do $$ begin
  perform tests.eq((select count(*) from public.notification_categories where enabled_globally), 1::bigint, 'only the weekly reminder is on by default');
  perform tests.eq((select count(*) from public.notifications_weekly_candidates('2026-W43')
                    where user_id in (current_setting('t.a')::uuid, current_setting('t.b')::uuid, current_setting('t.p')::uuid)), 2::bigint,
    'approved drivers get the reminder; pending do not');
end $$;

-- Driver B opts out
select tests.login(current_setting('t.b')::uuid);
select public.set_notification_preference('WEEKLY_REMINDER', false);
select tests.logout();

-- A's reminder is sent once
select public.notification_record(current_setting('t.a')::uuid, 'WEEKLY_REMINDER', 'WEEKLY_REMINDER:2026-W43:' || current_setting('t.a'), 'SENT', 'msg_1');
do $$ begin
  perform tests.eq((select count(*) from public.notifications_weekly_candidates('2026-W43')
                    where user_id in (current_setting('t.a')::uuid, current_setting('t.b')::uuid)), 0::bigint, 'sent and opted-out drivers excluded');
  perform tests.eq((select count(*) from public.notifications_weekly_candidates('2026-W44') where user_id = current_setting('t.a')::uuid), 1::bigint,
    'next week A is eligible again');
  perform tests.eq(public.notifications_sent_today(), 1, 'daily counter');
end $$;

-- A failed send can be retried and is recorded, not duplicated
select public.notification_record(current_setting('t.a')::uuid, 'WEEKLY_REMINDER', 'k-retry', 'FAILED', null, 'timeout');
select public.notification_record(current_setting('t.a')::uuid, 'WEEKLY_REMINDER', 'k-retry', 'SENT', 'msg_2');
do $$ begin
  perform tests.eq((select attempts from public.notification_deliveries where dedupe_key = 'k-retry'), 2, 'attempts counted');
  perform tests.eq((select status::text from public.notification_deliveries where dedupe_key = 'k-retry'), 'SENT', 'final status');
end $$;

-- Clients cannot trigger sends or read the candidate list
select tests.login(current_setting('t.a')::uuid);
select tests.throws($$select * from public.notifications_weekly_candidates('x')$$, '42501', 'driver cannot list candidates');
select tests.throws($$select public.set_notification_preference('NOPE', true)$$, 'VALIDATION', 'unknown category rejected');
select tests.logout();
