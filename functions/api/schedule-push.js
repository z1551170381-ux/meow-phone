// functions/api/schedule-push.js — 接收客户端的定时推送请求
// POST { uid, npcId, npcName, text, pushAt }  → 存入 scheduled_push 表
// POST { uid, action: 'cancel' }              → 取消该用户所有未发的 pending

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const uid = String(body.uid || '').trim();
    if (!uid) return jsonResp({ ok: false, error: 'missing uid' }, 400);

    // ── 取消模式 ──
    if (body.action === 'cancel') {
      // 把该用户所有未发送的消息标记为取消
      const url = `${env.SUPABASE_URL}/rest/v1/meow_scheduled_push?uid=eq.${encodeURIComponent(uid)}&is_sent=eq.false&is_cancelled=eq.false`;
      await fetch(url, {
        method: 'PATCH',
        headers: sbHeaders(env),
        body: JSON.stringify({ is_cancelled: true, cancelled_at: new Date().toISOString() })
      });
      return jsonResp({ ok: true, action: 'cancelled' });
    }

    // ── 创建定时推送 ──
    const npcId   = String(body.npcId   || '').trim();
    const npcName = String(body.npcName || '').trim();
    const text    = String(body.text    || '').trim();
    const pushAt  = Number(body.pushAt  || 0);

    if (!npcId || !text || !pushAt) {
      return jsonResp({ ok: false, error: 'missing npcId/text/pushAt' }, 400);
    }

    // 安全检查：pushAt 不能在过去，也不能超过 24 小时后
    const now = Date.now();
    if (pushAt < now) {
      return jsonResp({ ok: false, error: 'pushAt in the past' }, 400);
    }
    if (pushAt - now > 24 * 60 * 60 * 1000) {
      return jsonResp({ ok: false, error: 'pushAt too far in future' }, 400);
    }

    // 插入
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

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('Supabase insert failed: ' + resp.status + ' ' + errText.slice(0, 200));
    }

    return jsonResp({ ok: true, pushAt: new Date(pushAt).toISOString() });

  } catch (err) {
    return jsonResp({ ok: false, error: String(err.message || err) }, 500);
  }
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
