-- Minimal assertion helpers for SQL tests (pgTAP is not required).
create schema if not exists tests;

create or replace function tests.fail(msg text) returns void language plpgsql as $$
begin raise exception 'ASSERTION FAILED: %', msg; end $$;

create or replace function tests.eq(actual anyelement, expected anyelement, msg text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    perform tests.fail(format('%s (expected %s, got %s)', msg, expected, actual));
  end if;
end $$;

create or replace function tests.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then perform tests.fail(msg); end if; end $$;

-- Run SQL and require it to fail with an error whose message starts with p_prefix
-- (or whose SQLSTATE equals p_prefix when it is 5 characters).
create or replace function tests.throws(p_sql text, p_prefix text, msg text) returns void language plpgsql as $$
declare v_msg text; v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if v_msg like p_prefix || '%' or v_state = p_prefix then return; end if;
    perform tests.fail(format('%s: wrong error [%s] %s', msg, v_state, v_msg));
  end;
  perform tests.fail(format('%s: expected an error starting with %s', msg, p_prefix));
end $$;

-- Act as a signed-in user (or anon when p_user is null) for the rest of the transaction.
create or replace function tests.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  if p_user is null then execute 'set local role anon'; else execute 'set local role authenticated'; end if;
end $$;

create or replace function tests.logout() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

create or replace function tests.new_user(p_email text) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into auth.users (email) values (p_email) returning id into v;
  return v;
end $$;

grant usage on schema tests to anon, authenticated, service_role;
grant execute on all functions in schema tests to anon, authenticated, service_role;
