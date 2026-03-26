// functions/api/schedule-push.js — v2.1 状态机版
// 变更：
//   - 新增 state 字段替代 is_sent/is_cancelled（兼容期同时写入旧字段）
//   - 新增 expires_at、source_batch_id、channel、cancel_reason、skip_reason、behavior_type
//   - 取消旧 pending 时保留有效的 promised slot
// POST { uid, messages: [{npcId, npcName, text, pushAt, slot}, ...] }
// POST { uid, action: 'cancel' }
// POST { uid, action: 'replace_npc_pending', npcId, messages: [...] }

const EXPIRES_HOURS = 2;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
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
      await cancelAllPending(env, uid, 'manual_cancel');
      return jsonResp({ ok: true, action: 'cancelled' });
    }

    // ── 替换模式：取消旧 pending（保留 promised），插入新 batch ──
    if (body.action === 'replace_npc_pending') {
      const npcId = String(body.npcId || '').trim();
      if (!npcId) return jsonResp({ ok: false, error: 'missing npcId' }, 400);

      const messages = body.messages;
      if (!Array.isArray(messages) || !messages.length) {
        return jsonResp({ ok: false, error: 'missing messages array' }, 400);
      }

      const batchId   = String(body.batchId   || ('bg_' + npcId + '_' + Date.now()));
      const batchKind = String(body.batchKind  || 'bgpush');
      const source    = String(body.source     || 'chat_update');
      const now       = Date.now();

      // 第一步：取消该 NPC 旧的 planned（★ 保留 promised）
      let cancelledCount = 0;
      try {
        cancelledCount = await cancelNpcPending(env, uid, npcId, 'new_batch_replace');
      } catch(e) {
        console.error('[schedule-push] cancel old pending failed:', e);
      }

      // 第二步：构建新 rows
      const rows = buildRows(messages, { uid, npcId, npcName: body.npcName, batchId, batchKind, source, now });

      if (!rows.length) {
        return jsonResp({ ok: false, error: 'no valid messages after filter' }, 400);
      }

      // 第三步：插入
      await insertRows(env, rows);

      return jsonResp({
        ok: true,
        action: 'replace_npc_pending',
        cancelled: cancelledCount,
        inserted: rows.length,
        batchId
      });
    }

    // ── 批量创建 ──
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length) {
      if (body.npcId && body.text && body.pushAt) {
        return await insertSingle(env, uid, body);
      }
      return jsonResp({ ok: false, error: 'missing messages array' }, 400);
    }

    const now = Date.now();
    const npcIdSet = new Set();
    const rows = [];

    for (const msg of messages) {
      const npcId   = String(msg.npcId   || '').trim();
      const npcName = String(msg.npcName || '').trim();
      const text    = String(msg.text    || '').trim();
      const pushAt  = Number(msg.pushAt  || 0);

      if (!npcId || !text || !pushAt) continue;
      if (pushAt < now - 60000) continue;
      if (pushAt - now > 48 * 60 * 60 * 1000) continue;

      rows.push(makeRow({
        uid, npcId, npcName, text, pushAt,
        slot: msg.slot, batchId: null, batchKind: null, source: 'batch_insert'
      }));
      npcIdSet.add(npcId);
    }

    if (!rows.length) {
      return jsonResp({ ok: false, error: 'no valid messages' }, 400);
    }

    for (const nid of npcIdSet) {
      await cancelNpcPending(env, uid, nid, 'new_batch_replace');
    }

    await insertRows(env, rows);

    return jsonResp({
      ok: true,
      inserted: rows.length,
      replaced_npc_ids: Array.from(npcIdSet)
    });

  } catch (err) {
    return jsonResp({ ok: false, error: String(err.message || err) }, 500);
  }
}

// ═══════════════════════════════════════════
//  核心函数
// ═══════════════════════════════════════════

function makeRow({ uid, npcId, npcName, text, pushAt, slot, batchId, batchKind, source }) {
  const pushAtMs = Number(pushAt);
  const expiresAt = new Date(pushAtMs + EXPIRES_HOURS * 60 * 60 * 1000).toISOString();

  return {
    uid,
    npc_id:          String(npcId).trim(),
    npc_name:        String(npcName || '').trim(),
    text:            String(text || '').trim().slice(0, 200),
    push_at:         new Date(pushAtMs).toISOString(),
    slot:            String(slot || ''),
    // ★ 状态机字段
    state:           'planned',
    expires_at:      expiresAt,
    source_batch_id: batchId || null,
    channel:         'backend-push',
    skip_reason:     null,
    cancel_reason:   null,
    behavior_type:   null,
    // 兼容旧字段
    is_sent:         false,
    is_cancelled:    false,
    batch_id:        batchId || null,
    batch_kind:      batchKind || null,
    source:          source || 'chat_update',
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString()
  };
}

function buildRows(messages, opts) {
  const { uid, npcId, npcName, batchId, batchKind, source, now } = opts;
  const rows = [];
  for (const msg of messages) {
    const msgNpcId  = String(msg.npcId   || npcId).trim();
    const name      = String(msg.npcName || npcName || '').trim();
    const text      = String(msg.text    || '').trim();
    const pushAt    = Number(msg.pushAt  || 0);
    if (!text || !pushAt) continue;
    if (pushAt < now - 60000) continue;
    if (pushAt - now > 48 * 60 * 60 * 1000) continue;
    rows.push(makeRow({ uid, npcId: msgNpcId, npcName: name, text, pushAt, slot: msg.slot, batchId, batchKind, source }));
  }
  return rows;
}

async function insertRows(env, rows) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/meow_scheduled_push`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Supabase insert failed: ' + resp.status + ' ' + errText.slice(0, 200));
  }
}

async function insertSingle(env, uid, body) {
  const npcId   = String(body.npcId   || '').trim();
  const npcName = String(body.npcName || '').trim();
  const text    = String(body.text    || '').trim();
  const pushAt  = Number(body.pushAt  || 0);
  if (!npcId || !text || !pushAt) {
    return jsonResp({ ok: false, error: 'invalid single payload' }, 400);
  }
  await cancelNpcPending(env, uid, npcId, 'new_single_replace');
  const row = makeRow({ uid, npcId, npcName, text, pushAt, slot: body.slot, batchId: null, batchKind: null, source: 'single_insert' });
  await insertRows(env, [row]);
  return jsonResp({ ok: true, inserted: 1, replaced_npc_ids: [npcId] });
}

// ★ 取消旧 pending 时保留 promised slot
async function cancelNpcPending(env, uid, npcId, reason) {
  const cancelUrl =
    `${env.SUPABASE_URL}/rest/v1/meow_scheduled_push` +
    `?uid=eq.${encodeURIComponent(uid)}` +
    `&npc_id=eq.${encodeURIComponent(npcId)}` +
    `&state=eq.planned` +
    `&slot=neq.promised`;

  const cancelResp = await fetch(cancelUrl, {
    method: 'PATCH',
    headers: { ...sbHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify({
      state:         'cancelled',
      cancel_reason: reason,
      is_cancelled:  true,
      cancelled_at:  new Date().toISOString(),
      updated_at:    new Date().toISOString()
    })
  });

  if (!cancelResp.ok) {
    const errText = await cancelResp.text();
    throw new Error('cancel pending failed: ' + cancelResp.status + ' ' + errText.slice(0, 200));
  }

  try {
    const rows = await cancelResp.json();
    return Array.isArray(rows) ? rows.length : 0;
  } catch(_) { return 0; }
}

async function cancelAllPending(env, uid, reason) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/meow_scheduled_push` +
    `?uid=eq.${encodeURIComponent(uid)}` +
    `&state=eq.planned`;

  await fetch(url, {
    method: 'PATCH',
    headers: sbHeaders(env),
    body: JSON.stringify({
      state:         'cancelled',
      cancel_reason: reason,
      is_cancelled:  true,
      cancelled_at:  new Date().toISOString(),
      updated_at:    new Date().toISOString()
    })
  });
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
