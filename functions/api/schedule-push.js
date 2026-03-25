// functions/api/schedule-push.js — 接收定时推送请求（支持批量）
// POST { uid, messages: [{npcId, npcName, text, pushAt}, ...] }  → 批量插入
// POST { uid, action: 'cancel' }  → 取消该用户所有未发的 pending

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // sendBeacon 可能发 text/plain，需要兼容
    let body;
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('json')) {
      body = await request.json();
    } else {
      const raw = await request.text();
      body = JSON.parse(raw);
    }

    const uid = String(body.uid || '').trim();
    if (!uid) return jsonResp({ ok: false, error: 'missing uid' }, 400);

    // ── 取消模式 ──
    if (body.action === 'cancel') {
      const url = `${env.SUPABASE_URL}/rest/v1/meow_scheduled_push?uid=eq.${encodeURIComponent(uid)}&is_sent=eq.false&is_cancelled=eq.false`;
      await fetch(url, {
        method: 'PATCH',
        headers: sbHeaders(env),
        body: JSON.stringify({ is_cancelled: true, cancelled_at: new Date().toISOString() })
      });
      return jsonResp({ ok: true, action: 'cancelled' });
    }

    // ── 批量创建定时推送 ──
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length) {
      // 兼容旧的单条格式
      if (body.npcId && body.text && body.pushAt) {
        return await insertSingle(env, uid, body);
      }
      return jsonResp({ ok: false, error: 'missing messages array' }, 400);
    }

    const now = Date.now();
    const rows = [];

    for (const msg of messages) {
      const npcId   = String(msg.npcId   || '').trim();
      const npcName = String(msg.npcName || '').trim();
      const text    = String(msg.text    || '').trim();
      const pushAt  = Number(msg.pushAt  || 0);

      if (!npcId || !text || !pushAt) continue;
      if (pushAt < now - 60000) continue;  // 过去的跳过（允许 1 分钟误差）
      if (pushAt - now > 48 * 60 * 60 * 1000) continue;  // 超过 48 小时的跳过

      rows.push({
        uid,
        npc_id: npcId,
        npc_name: npcName,
        text: text.slice(0, 200),
        push_at: new Date(pushAt).toISOString(),
        slot: String(msg.slot || ''),
        is_sent: false,
        is_cancelled: false,
        created_at: new Date().toISOString()
      });
    }

    if (!rows.length) {
      return jsonResp({ ok: false, error: 'no valid messages' }, 400);
    }

    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/meow_scheduled_push`, {
      method: 'POST',
      headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify(rows)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('Supabase insert failed: ' + resp.status + ' ' + errText.slice(0, 200));
    }

    return jsonResp({ ok: true, inserted: rows.length });

  } catch (err) {
    return jsonResp({ ok: false, error: String(err.message || err) }, 500);
  }
}

async function insertSingle(env, uid, body) {
  const npcId   = String(body.npcId   || '').trim();
  const npcName = String(body.npcName || '').trim();
  const text    = String(body.text    || '').trim();
  const pushAt  = Number(body.pushAt  || 0);

  const row = {
    uid,
    npc_id: npcId,
    npc_name: npcName,
    text: text.slice(0, 200),
    push_at: new Date(pushAt).toISOString(),
    is_sent: false,
    is_cancelled: false,
    created_at: new Date().toISOString()
  };

  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/meow_scheduled_push`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(row)
  });

  if (!resp.ok) throw new Error('Supabase insert failed: ' + resp.status);
  return jsonResp({ ok: true, inserted: 1 });
}

function sbHeaders(env) {
  return {
    'Content-Type': 'application/json',
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
