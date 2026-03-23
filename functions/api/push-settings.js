// functions/api/push-settings.js
// GET  /api/push-settings?uid=standalone_main
// POST /api/push-settings

const DEFAULTS = {
  uid: 'standalone_main',
  enable_push: true,
  daily_guaranteed_count: 1,
  random_max_count: 1,
  random_cooldown_minutes: 240,
  quiet_hours_start: '23:30',
  quiet_hours_end: '08:00',
  daily_windows: ['11:00-13:00'],
  random_windows: ['19:30-22:30'],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function normTimeStr(v, fallback) {
  const s = String(v || '').trim();
  return /^\d{2}:\d{2}$/.test(s) ? s : fallback;
}

function normWindowList(v, fallback) {
  if (!Array.isArray(v)) return fallback;
  const out = v
    .map(x => String(x || '').trim())
    .filter(x => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(x));
  return out.length ? out : fallback;
}

function sanitizePayload(input) {
  const src = input || {};
  return {
    uid: String(src.uid || DEFAULTS.uid).trim() || DEFAULTS.uid,
    enable_push: !!src.enable_push,
    daily_guaranteed_count: Math.max(0, Math.min(10, Number(src.daily_guaranteed_count ?? DEFAULTS.daily_guaranteed_count) || 0)),
    random_max_count: Math.max(0, Math.min(20, Number(src.random_max_count ?? DEFAULTS.random_max_count) || 0)),
    random_cooldown_minutes: Math.max(10, Math.min(24 * 60, Number(src.random_cooldown_minutes ?? DEFAULTS.random_cooldown_minutes) || DEFAULTS.random_cooldown_minutes)),
    quiet_hours_start: normTimeStr(src.quiet_hours_start, DEFAULTS.quiet_hours_start),
    quiet_hours_end: normTimeStr(src.quiet_hours_end, DEFAULTS.quiet_hours_end),
    daily_windows: normWindowList(src.daily_windows, DEFAULTS.daily_windows),
    random_windows: normWindowList(src.random_windows, DEFAULTS.random_windows),
    updated_at: new Date().toISOString()
  };
}

async function sbSelectOne(env, uid) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/meow_push_settings` +
    `?select=*` +
    `&uid=eq.${encodeURIComponent(uid)}` +
    `&limit=1`;

  const resp = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`select ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const arr = await resp.json();
  return arr && arr[0] ? arr[0] : null;
}

async function sbUpsert(env, row) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/meow_push_settings` +
    `?on_conflict=uid`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(row)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`upsert ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const arr = await resp.json();
  return arr && arr[0] ? arr[0] : row;
}

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const uid = String(url.searchParams.get('uid') || DEFAULTS.uid).trim() || DEFAULTS.uid;

    const row = await sbSelectOne(env, uid);
    return json({
      ok: true,
      settings: row ? { ...DEFAULTS, ...row } : { ...DEFAULTS, uid }
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const row = sanitizePayload(body);
    const saved = await sbUpsert(env, row);
    return json({
      ok: true,
      settings: { ...DEFAULTS, ...saved }
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
