// netlify/functions/subscribe.js （改造版 - 用户自带 API Key）
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch(e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { uid, subscription, npcs, apiConfig } = body;

  if (!uid || !subscription || !subscription.endpoint) {
    return { statusCode: 400, body: 'Missing uid or subscription' };
  }

  const keys = subscription.keys || {};

  try {
    // 1. 存/更新设备订阅
    const { error: devErr } = await supabase
      .from('meow_devices')
      .upsert({
        uid,
        endpoint:   subscription.endpoint,
        p256dh:     keys.p256dh || '',
        auth:       keys.auth   || '',
        updated_at: new Date().toISOString()
      }, { onConflict: 'endpoint' });

    if (devErr) throw devErr;

    // 2. 存用户的 API 配置（用户自己的 Key，后端调 AI 时用）
    if (apiConfig && apiConfig.apiKey && apiConfig.baseUrl) {
      const { error: apiErr } = await supabase
        .from('meow_user_api_config')
        .upsert({
          uid,
          base_url:   String(apiConfig.baseUrl || '').trim(),
          api_key:    String(apiConfig.apiKey  || '').trim(),
          model:      String(apiConfig.model   || '').trim(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'uid' });

      if (apiErr) console.warn('[subscribe] api config error:', apiErr);
    }

    // 3. 存/更新角色推送配置
    if (Array.isArray(npcs) && npcs.length > 0) {
      for (const npc of npcs) {
        if (!npc.id) continue;
        await supabase
          .from('meow_npc_push_config')
          .upsert({
            uid,
            npc_id:             String(npc.id),
            npc_name:           String(npc.name    || npc.id),
            npc_profile:        String(npc.profile || '').slice(0, 500),
            enable_push:        npc.enableLifePush !== false,
            bond:               String(npc.bond    || '普通'),
            online_chat_prompt: String(npc.onlineChatPrompt || '').slice(0, 500),
            updated_at:         new Date().toISOString()
          }, { onConflict: 'uid,npc_id' });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };

  } catch(err) {
    console.error('[subscribe] error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(err.message || err) })
    };
  }
};
