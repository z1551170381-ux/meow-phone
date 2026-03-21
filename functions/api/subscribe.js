// functions/api/subscribe.js
// 完全无依赖版 - 直接用 fetch 调 Supabase REST API

async function supabaseUpsert(env, table, data, onConflict) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(data)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase ${table} error: ${err.slice(0, 200)}`);
  }
  return resp;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch(e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { uid, subscription, npcs, apiConfig, enableBackgroundPush } = body;

  if (!uid || !subscription || !subscription.endpoint) {
    return new Response('Missing uid or subscription', { status: 400 });
  }

  const keys = subscription.keys || {};

  try {
    // 1. 存设备订阅
    await supabaseUpsert(env, 'meow_devices', {
      uid,
      endpoint:   subscription.endpoint,
      p256dh:     keys.p256dh || '',
      auth:       keys.auth   || '',
      updated_at: new Date().toISOString()
    }, 'endpoint');

    // 2. 只有用户主动开启后台推送时才存 API Key
    if (enableBackgroundPush && apiConfig && apiConfig.apiKey && apiConfig.baseUrl) {
      await supabaseUpsert(env, 'meow_user_api_config', {
        uid,
        base_url:   String(apiConfig.baseUrl || '').trim(),
        api_key:    String(apiConfig.apiKey  || '').trim(),
        model:      String(apiConfig.model   || '').trim(),
        updated_at: new Date().toISOString()
      }, 'uid');
    }

    // 3. 存角色配置
    if (Array.isArray(npcs) && npcs.length > 0) {
      for (const npc of npcs) {
        if (!npc.id) continue;
        await supabaseUpsert(env, 'meow_npc_push_config', {
          uid,
          npc_id:             String(npc.id),
          npc_name:           String(npc.name    || npc.id),
          npc_profile:        String(npc.profile || '').slice(0, 500),
          enable_push:        npc.enableLifePush !== false,
          bond:               String(npc.bond    || '普通'),
          online_chat_prompt: String(npc.onlineChatPrompt || '').slice(0, 500),
          updated_at:         new Date().toISOString()
        }, 'uid,npc_id');
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(err) {
    console.error('[subscribe] error:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
