// TEST-ONLY stand-in for Supabase's REST (PostgREST) and Auth (GoTrue) HTTP APIs.
//
// It lets the real web app run end to end against the REAL database schema,
// Row Level Security and functions on a throwaway local Postgres, in
// environments where the Supabase Docker images cannot be downloaded.
// Every request runs inside a transaction as role `authenticated` (or `anon`)
// with request.jwt.claim.sub set, exactly as PostgREST does, so RLS applies.
//
// Implements only the subset of PostgREST syntax this app uses. Login codes are
// always 123456. Never expose this server to a network.
import http from 'node:http';
import pg from 'pg';

const PORT = Number(process.env.SHIM_PORT ?? 54321);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pg.types.setTypeParser(1082, (v) => v); // date as string

const b64u = (s) => Buffer.from(s).toString('base64url');
function makeToken(user) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = { sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp, iat: exp - 3600 };
  return `${b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}.test`;
}
function readToken(req) {
  const h = req.headers.authorization ?? '';
  const t = h.replace(/^Bearer\s+/i, '');
  const parts = t.split('.');
  if (parts.length !== 3 || parts[2] !== 'test') return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
}
function session(user) {
  return { access_token: makeToken(user), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `refresh-${user.id}`, user: userJson(user) };
}
function userJson(u) {
  return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(),
    app_metadata: { provider: 'email' }, user_metadata: u.raw_user_meta_data ?? {}, created_at: u.created_at };
}

const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;
const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s) { if (!IDENT.test(s)) throw httpErr(400, 'PGRST100', `bad identifier ${s}`); return qi(s); }
function httpErr(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

// ---------------------------------------------------------------- filters
function splitTop(s, sep = ',') {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function condition(alias, col, opval, params) {
  const dot = opval.indexOf('.');
  let op = opval.slice(0, dot); let val = opval.slice(dot + 1);
  let neg = false;
  if (op === 'not') { neg = true; const d2 = val.indexOf('.'); op = val.slice(0, d2); val = val.slice(d2 + 1); }
  const c = `${alias}.${ident(col)}`;
  const p = (v) => { params.push(v); return `$${params.length}`; };
  let sql;
  switch (op) {
    case 'eq': sql = `${c} = ${p(val)}`; break;
    case 'neq': sql = `${c} <> ${p(val)}`; break;
    case 'lt': sql = `${c} < ${p(val)}`; break;
    case 'lte': sql = `${c} <= ${p(val)}`; break;
    case 'gt': sql = `${c} > ${p(val)}`; break;
    case 'gte': sql = `${c} >= ${p(val)}`; break;
    case 'like': sql = `${c}::text like ${p(val.replace(/\*/g, '%'))}`; break;
    case 'ilike': sql = `${c}::text ilike ${p(val.replace(/\*/g, '%'))}`; break;
    case 'is': sql = `${c} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : val === 'false' ? 'false' : 'null'}`; break;
    case 'in': {
      const items = val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
      sql = `${c}::text = any(${p(items)}::text[])`; break;
    }
    default: throw httpErr(400, 'PGRST100', `unsupported operator ${op}`);
  }
  return neg ? `not (${sql})` : sql;
}
function whereClause(alias, query, params) {
  const conds = [];
  for (const [k, v] of query) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    if (k === 'or' || k === 'and') {
      const inner = splitTop(v.replace(/^\(|\)$/g, '')).map((part) => {
        const d = part.indexOf('.');
        return condition(alias, part.slice(0, d), part.slice(d + 1), params);
      });
      conds.push(`(${inner.join(k === 'or' ? ' or ' : ' and ')})`);
    } else {
      conds.push(condition(alias, k, v, params));
    }
  }
  return conds.length ? `where ${conds.join(' and ')}` : '';
}

// ---------------------------------------------------------------- select with embeds
async function fkBetween(client, child, parent) {
  const r = await client.query(`
    select a.attname as child_col, af.attname as parent_col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
    where c.contype = 'f' and c.conrelid = $1::regclass and c.confrelid = $2::regclass limit 1`, [`public.${child}`, `public.${parent}`]);
  if (!r.rows[0]) throw httpErr(400, 'PGRST200', `no relationship between ${parent} and ${child}`);
  return r.rows[0];
}
async function selectExpr(client, table, alias, select) {
  const items = splitTop(select || '*').map((s) => s.trim()).filter(Boolean);
  const plain = [];
  const embeds = [];
  let star = false;
  for (const it of items) {
    const m = /^([a-z_][a-z0-9_]*)\((.*)\)$/s.exec(it);
    if (m) {
      const rel = m[1];
      const fk = await fkBetween(client, rel, table);
      const cols = splitTop(m[2]).map((x) => x.trim());
      const obj = cols.includes('*') ? `to_jsonb(e)` : `jsonb_build_object(${cols.map((c) => `'${c}', e.${ident(c)}`).join(', ')})`;
      embeds.push(`'${rel}', (select coalesce(jsonb_agg(${obj}), '[]'::jsonb) from public.${ident(rel)} e where e.${ident(fk.child_col)} = ${alias}.${ident(fk.parent_col)})`);
    } else if (it === '*') star = true;
    else plain.push(it);
  }
  const base = star ? `to_jsonb(${alias})` : `jsonb_build_object(${plain.map((c) => `'${c}', ${alias}.${ident(c)}`).join(', ') || ''})`;
  return embeds.length ? `${base} || jsonb_build_object(${embeds.join(', ')})` : base;
}
function orderClause(alias, order) {
  if (!order) return '';
  const parts = order.split(',').map((o) => {
    const [col, dir, nulls] = o.split('.');
    return `${alias}.${ident(col)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullsfirst' ? ' nulls first' : nulls === 'nullslast' ? ' nulls last' : ''}`;
  });
  return `order by ${parts.join(', ')}`;
}

// ---------------------------------------------------------------- RPC
const fnCache = new Map();
async function fnInfo(client, name) {
  if (fnCache.has(name)) return fnCache.get(name);
  const r = await client.query(`
    select p.proretset, p.prorettype::regtype::text as rettype,
           coalesce(p.proargnames, '{}') as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1`, [name]);
  if (!r.rows[0]) throw httpErr(404, 'PGRST202', `function ${name} not found`);
  fnCache.set(name, r.rows[0]);
  return r.rows[0];
}
async function rpc(client, name, args) {
  const info = await fnInfo(client, ident(name).slice(1, -1));
  const params = [];
  const named = Object.entries(args ?? {}).map(([k, v]) => {
    const idx = info.names.indexOf(k);
    const type = idx >= 0 ? info.types[idx] : 'text';
    params.push(type === 'jsonb' || type === 'json' ? JSON.stringify(v) : v);
    return `${ident(k)} => $${params.length}::${type}`;
  });
  const call = `public.${ident(name)}(${named.join(', ')})`;
  if (info.proretset) {
    const r = await client.query(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as result from ${call} t`, params);
    return r.rows[0].result;
  }
  if (info.rettype === 'void') { await client.query(`select ${call}`, params); return null; }
  const r = await client.query(`select to_jsonb(${call}) as result`, params);
  return r.rows[0].result;
}

// ---------------------------------------------------------------- HTTP
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : null;
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(data === undefined ? '' : JSON.stringify(data));
}
async function asUser(claims, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [claims?.sub ?? '']);
    await client.query(claims ? 'set local role authenticated' : 'set local role anon');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function asOwner(fn) {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

const codes = new Map(); // email -> code

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization, apikey, content-type, prefer, accept, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'content-range',
  };
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  try {
    // ---------------- Auth
    if (url.pathname === '/auth/v1/otp' && req.method === 'POST') {
      const b = await body(req);
      const email = String(b.email).toLowerCase();
      await asOwner((c) => c.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) on conflict (email) do nothing`, [email, b.data ?? {}]));
      codes.set(email, '123456');
      return send(res, 200, {});
    }
    if (url.pathname === '/auth/v1/verify' && req.method === 'POST') {
      const b = await body(req);
      const email = String(b.email).toLowerCase();
      if (codes.get(email) !== b.token) return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      const u = await asOwner((c) => c.query('select * from auth.users where email = $1', [email]));
      return send(res, 200, session(u.rows[0]));
    }
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      const b = await body(req);
      const id = String(b.refresh_token ?? '').replace(/^refresh-/, '');
      const u = await asOwner((c) => c.query('select * from auth.users where id::text = $1', [id]));
      if (!u.rows[0]) return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, session(u.rows[0]));
    }
    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const claims = readToken(req);
      if (!claims) return send(res, 401, { msg: 'invalid JWT' });
      const u = await asOwner((c) => c.query('select * from auth.users where id = $1', [claims.sub]));
      return send(res, 200, userJson(u.rows[0]));
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204);
    if (url.pathname.startsWith('/functions/v1/')) {
      return send(res, 503, { error: 'NOT_AVAILABLE_IN_TEST', message: 'Edge Functions are not available in the local test environment.' });
    }

    // ---------------- REST
    const m = /^\/rest\/v1\/(rpc\/)?([a-z_][a-z0-9_]*)$/.exec(url.pathname);
    if (!m) return send(res, 404, { message: 'not found' });
    const claims = readToken(req);
    const [, isRpc, name] = m;
    const query = [...url.searchParams.entries()];
    const wantsObject = (req.headers.accept ?? '').includes('vnd.pgrst.object');

    const result = await asUser(claims, async (client) => {
      if (isRpc) return { status: 200, data: await rpc(client, name, await body(req)) };
      const t = ident(name);
      const select = url.searchParams.get('select');
      const params = [];
      if (req.method === 'GET') {
        const expr = await selectExpr(client, name, 'x', select);
        const where = whereClause('x', query, params);
        const order = orderClause('x', url.searchParams.get('order'));
        const limit = url.searchParams.get('limit') ? `limit ${Number(url.searchParams.get('limit'))}` : '';
        const offset = url.searchParams.get('offset') ? `offset ${Number(url.searchParams.get('offset'))}` : '';
        const r = await client.query(`select coalesce(jsonb_agg(row_data), '[]'::jsonb) as rows from (select ${expr} as row_data from public.${t} x ${where} ${order} ${limit} ${offset}) s`, params);
        return { status: 200, data: r.rows[0].rows };
      }
      const prefer = req.headers.prefer ?? '';
      const ret = prefer.includes('return=representation');
      const retExpr = ret ? await selectExpr(client, name, 'x', select) : null;
      if (req.method === 'POST') {
        const b = await body(req);
        const rows = Array.isArray(b) ? b : [b];
        const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(ident);
        params.push(JSON.stringify(rows));
        const r = await client.query(`insert into public.${t} as x (${cols.join(', ')}) select ${cols.join(', ')} from jsonb_populate_recordset(null::public.${t}, $1::jsonb) ${ret ? `returning ${retExpr} as row_data` : ''}`, params);
        return { status: 201, data: ret ? r.rows.map((x) => x.row_data) : undefined };
      }
      if (req.method === 'PATCH') {
        const b = await body(req);
        const cols = Object.keys(b).map(ident);
        params.push(JSON.stringify(b));
        const where = whereClause('x', query, params);
        const r = await client.query(`update public.${t} as x set (${cols.join(', ')}) = (select ${cols.join(', ')} from jsonb_populate_record(null::public.${t}, $1::jsonb)) ${where} ${ret ? `returning ${retExpr} as row_data` : ''}`, params);
        return { status: 200, data: ret ? r.rows.map((x) => x.row_data) : undefined };
      }
      if (req.method === 'DELETE') {
        const where = whereClause('x', query, params);
        const r = await client.query(`delete from public.${t} as x ${where} ${ret ? `returning ${retExpr} as row_data` : ''}`, params);
        return { status: 200, data: ret ? r.rows.map((x) => x.row_data) : undefined };
      }
      throw httpErr(405, 'PGRST000', 'method not allowed');
    });

    if (wantsObject && Array.isArray(result.data)) {
      if (result.data.length !== 1) return send(res, 406, { code: 'PGRST116', details: `The result contains ${result.data.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
      return send(res, 200, result.data[0]);
    }
    if (result.data === undefined) return send(res, result.status === 201 ? 201 : 204);
    return send(res, result.status, result.data);
  } catch (e) {
    const code = e.code ?? 'PGRST000';
    const status = e.status ?? (code === '42501' ? (readToken(req) ? 403 : 401) : code === 'P0001' ? 400 : code.startsWith('23') ? 409 : 400);
    if (!e.status && !['P0001', '42501'].includes(code) && !code.startsWith('23')) console.error('[shim]', req.method, req.url, e.message);
    return send(res, status, { code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`supabase test shim on http://127.0.0.1:${PORT}`));
