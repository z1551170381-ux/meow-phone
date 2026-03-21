// functions/api/subscribe.js
// Cloudflare Pages Functions - 用 CDN URL 引入依赖

export async function onRequestPost(context) {
  const { request, env } = context;

  // 动态引入 supabase（CDN）
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

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

    // 2. 只有用户主动开启后台推送时才存 API Key
    if (enableBackgroundPush && apiConfig && apiConfig.apiKey && apiConfig.baseUrl) {
      await supabase
        .from('meow_user_api_config')
        .upsert({
          uid,
          base_url:   String(apiConfig.baseUrl || '').trim(),
          api_key:    String(apiConfig.apiKey  || '').trim(),
          model:      String(apiConfig.model   || '').trim(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'uid' });
    }

    // 3. 存角色配置
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
