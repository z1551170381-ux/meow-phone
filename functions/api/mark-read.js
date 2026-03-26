// functions/api/mark-read.js — v2.1
// 用户点开某个角色的聊天时，前端调用此接口
// POST { uid, npcId }
// 更新 meow_npc_push_config.last_chat_opened_at
// 同时把该角色 state='sent' 的消息标记为 state='opened'

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

    const uid   = String(body.uid   || '').trim();
    const npcId = String(body.npcId || body.npc_id || '').trim();
    const userReplied = !!body.userReplied;

    if (!uid || !npcId) {
      return jsonResp({ ok: false, error: 'missing uid or npcId' }, 400);
    }

    const base = env.SUPABASE_URL;
    const key  = env.SUPABASE_SERVICE_KEY;
    if (!base || !key) {
      return jsonResp({ ok: false, error: 'missing env config' }, 500);
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`
    };

    const now = new Date().toISOString();

    // 1. 更新 meow_npc_push_config 的会话状态
    const updateData = {
      last_chat_opened_at: now,
      updated_at: now
    };
    // 如果是用户回复，同时更新 last_user_replied_at
    if (userReplied) {
      updateData.last_user_replied_at = now;
    }

    const configUrl =
      `${base}/rest/v1/meow_npc_push_config` +
      `?uid=eq.${encodeURIComponent(uid)}` +
      `&npc_id=eq.${encodeURIComponent(npcId)}`;

    const configResp = await fetch(configUrl, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(updateData)
    });

    // 如果该角色配置行不存在，尝试 upsert
    if (!configResp.ok) {
      const upsertData = {
        uid,
        npc_id: npcId,
        last_chat_opened_at: now,
        updated_at: now
      };
      if (userReplied) {
        upsertData.last_user_replied_at = now;
      }

      const upsertUrl =
        `${base}/rest/v1/meow_npc_push_config` +
        `?on_conflict=uid,npc_id`;

      await fetch(upsertUrl, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(upsertData)
      });
    }

    // 2. 把该角色 state='sent' 的消息标记为 state='opened'
    //    （如果是 userReplied，直接标记为 'replied'）
    const targetState = userReplied ? 'replied' : 'opened';
    let updatedCount = 0;
    try {
      const pushUrl =
        `${base}/rest/v1/meow_scheduled_push` +
        `?uid=eq.${encodeURIComponent(uid)}` +
        `&npc_id=eq.${encodeURIComponent(npcId)}` +
        `&state=in.(sent,opened)`;

      const pushResp = await fetch(pushUrl, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          state: targetState,
          updated_at: now
        })
      });

      if (pushResp.ok) {
        try {
          const rows = await pushResp.json();
          updatedCount = Array.isArray(rows) ? rows.length : 0;
        } catch(_) {}
      }
    } catch(e) {
      console.warn('[mark-read] update push state error:', e);
    }

    return jsonResp({
      ok: true,
      uid,
      npcId,
      action: userReplied ? 'replied' : 'opened',
      at: now,
      messagesUpdated: updatedCount
    });

  } catch (err) {
    console.error('[mark-read] error:', err);
    return jsonResp({ ok: false, error: String(err.message || err) }, 500);
  }
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
