// functions/api/proactive.js
// Cloudflare Pages Functions - 用 CDN URL 引入依赖

function isDailyWindow(now) {
  const h = new Date(now).getHours();
  return h >= 10 && h <= 22;
}
function isRandomWindow(now) {
  const h = new Date(now).getHours();
  return h >= 8 && h <= 23;
}
function todayKey(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

async function generateMessage(npc, kind, apiCfg) {
  const { base_url, api_key, model } = apiCfg;
  if (!api_key || !base_url || !model) throw new Error('用户未配置 API');

  const bondMap = {
    '亲近': '可以更自然地关心和分享。',
    '暧昧': '可以带一点试探和在意。',
    '疏远': '语气要克制一点，不要太亲密。',
    '普通': '保持自然、有分寸。'
  };
  const kindLabel = kind === 'daily' ? '在今天的间隙里想起了你' : '突然想起你了';

  const systemPrompt = [
    `你正在扮演「${npc.npc_name}」。`,
    npc.npc_profile || '',
    `【关系阶段】当前你和用户的关系：${npc.bond || '普通'}。${bondMap[npc.bond] || bondMap['普通']}`,
    npc.online_chat_prompt ? `【附加要求】\n${npc.online_chat_prompt}` : '',
    `【行为背景】你${kindLabel}，想主动联系用户。`,
    `【输出要求】只发 1 条消息，1-3 句，60 字以内。不要引号，不要解释。`
  ].filter(Boolean).join('\n\n');

  const resp = await fetch(`${base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api_key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: '（请直接输出那条消息）' }
      ],
      temperature: 0.9,
      max_tokens: 100
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI 错误 ${resp.status}: ${errText.slice(0, 100)}`);
  }

  const data = await resp.json();
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  return raw.replace(/^["「『【]|["」』】]$/g, '').slice(0, 120);
}

// 用纯 fetch 实现 Web Push（不依赖 npm 包）
async function sendWebPush(device, payload, env) {
  // 使用 web-push 兼容的方式通过 VAPID 签名发送
  const { default: webpush } = await import('https://esm.sh/web-push@3.6.7');

  webpush.setVapidDetails(
    'mailto:' + env.VAPID_EMAIL,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      JSON.stringify(payload)
    );
    return 'ok';
  } catch(err) {
    if (err.statusCode === 410 || err.statusCode === 404) return 'expired';
    console.warn('[push] 失败:', err.message);
    return 'fail';
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';

  if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  const now = Date.now();
  const today = todayKey(now);
  const results = [];

  try {
    const { data: npcs, error: npcErr } = await supabase
      .from('meow_npc_push_config')
      .select('*')
      .eq('enable_push', true);

    if (npcErr) throw npcErr;
    if (!npcs || npcs.length === 0) {
      return new Response(JSON.stringify({ ok: true, msg: '暂无角色配置' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const byUid = {};
    for (const npc of npcs) {
      byUid[npc.uid] = byUid[npc.uid] || [];
      byUid[npc.uid].push(npc);
    }

    for (const uid of Object.keys(byUid)) {
      const { data: apiCfg } = await supabase
        .from('meow_user_api_config')
        .select('*')
        .eq('uid', uid)
        .single();

      if (!apiCfg || !apiCfg.api_key) {
        results.push({ uid, skipped: true, reason: '未开启后台推送' });
        continue;
      }

      for (const npc of byUid[uid]) {
        const { npc_id } = npc;

        const { data: cd } = await supabase
          .from('meow_push_cooldown')
          .select('*')
          .eq('uid', uid)
          .eq('npc_id', npc_id)
          .single();

        const cooldown = cd || {};
        let kind = null;

        if (isDailyWindow(now)) {
          const sentToday     = cooldown.last_daily_push_date === today;
          const recentlyTried = cooldown.last_daily_try_at &&
            (now - Number(cooldown.last_daily_try_at)) < 30 * 60 * 1000;
          if (!sentToday && !recentlyTried) kind = 'daily';
        }

        if (!kind && isRandomWindow(now)) {
          const lastRandom = Number(cooldown.last_random_push_at || 0);
          if (now - lastRandom > 2 * 60 * 60 * 1000 && Math.random() < 0.3) {
            kind = 'random';
          }
        }

        if (!kind) { results.push({ npc_id, skipped: true }); continue; }

        await supabase.from('meow_push_cooldown').upsert({
          uid, npc_id,
          last_daily_try_at:    kind === 'daily' ? now : (cooldown.last_daily_try_at || 0),
          last_daily_push_date: cooldown.last_daily_push_date || '',
          last_random_push_at:  cooldown.last_random_push_at  || 0,
          updated_at: new Date().toISOString()
        }, { onConflict: 'uid,npc_id' });

        let text = '';
        try {
          text = await generateMessage(npc, kind, apiCfg);
        } catch(aiErr) {
          results.push({ npc_id, error: aiErr.message });
          continue;
        }

        if (!text) { results.push({ npc_id, error: 'AI 返回空' }); continue; }

        const offsetMin = kind === 'daily'
          ? Math.floor(Math.random() * 30) + 5
          : Math.floor(Math.random() * 10) + 2;
        const msgTs = now - offsetMin * 60 * 1000;

        await supabase.from('meow_pending_messages').insert({
          uid, npc_id, npc_name: npc.npc_name,
          text, kind, ts: msgTs, is_pulled: false
        });

        await supabase.from('meow_push_cooldown').upsert({
          uid, npc_id,
          last_daily_push_date: kind === 'daily'  ? today : (cooldown.last_daily_push_date || ''),
          last_daily_try_at:    kind === 'daily'  ? now   : (cooldown.last_daily_try_at    || 0),
          last_random_push_at:  kind === 'random' ? now   : (cooldown.last_random_push_at  || 0),
          updated_at: new Date().toISOString()
        }, { onConflict: 'uid,npc_id' });

        const { data: devices } = await supabase
          .from('meow_devices').select('*').eq('uid', uid);

        let pushed = 0;
        for (const dev of (devices || [])) {
          const r = await sendWebPush(dev, { npcId: npc_id, npcName: npc.npc_name, text }, env);
          if (r === 'expired') {
            await supabase.from('meow_devices').delete().eq('endpoint', dev.endpoint);
          } else if (r === 'ok') {
            pushed++;
          }
        }

        results.push({ npc_id, kind, pushed, preview: text.slice(0, 20) });
      }
    }

    return new Response(JSON.stringify({ ok: true, total: results.length, results }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(err) {
    console.error('[proactive] fatal:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
