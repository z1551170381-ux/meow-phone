// netlify/functions/proactive.js （改造版 - 用户自带 API Key）
// 每个用户用自己存在 Supabase 里的 API Key 调 AI，你不需要出钱

const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'meow@example.com'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ========== 时间窗判断 ==========
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

// ========== 用用户自己的 Key 调 AI ==========
async function generateMessage(npc, kind, userApiConfig) {
  const { base_url, api_key, model } = userApiConfig;

  if (!api_key || !base_url || !model) {
    throw new Error('用户未配置 API');
  }

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
    `【主动消息生成规则】`,
    `- 根据关系阶段决定发什么，不要写成固定模板。`,
    `- 内容要像这个角色自己会说的话。`,
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

// ========== 发 Web Push ==========
async function sendPush(device, npcName, npcId, text) {
  const payload = JSON.stringify({ npcId, npcName, text });
  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      payload
    );
    return true;
  } catch(err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await supabase.from('meow_devices').delete().eq('endpoint', device.endpoint);
    }
    return false;
  }
}

// ========== 主流程 ==========
exports.handler = async function(event) {
  const secret = event.queryStringParameters?.secret || '';
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const now   = Date.now();
  const today = todayKey(now);
  const results = [];

  try {
    // 1. 读所有开启推送的角色
    const { data: npcs, error: npcErr } = await supabase
      .from('meow_npc_push_config')
      .select('*')
      .eq('enable_push', true);

    if (npcErr) throw npcErr;
    if (!npcs || npcs.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, msg: '暂无角色配置' }) };
    }

    // 按 uid 分组处理（每个用户的角色一起处理，只查一次 API 配置）
    const byUid = {};
    for (const npc of npcs) {
      byUid[npc.uid] = byUid[npc.uid] || [];
      byUid[npc.uid].push(npc);
    }

    for (const uid of Object.keys(byUid)) {
      // 2. 读该用户的 API 配置
      const { data: apiCfg } = await supabase
        .from('meow_user_api_config')
        .select('*')
        .eq('uid', uid)
        .single();

      if (!apiCfg || !apiCfg.api_key) {
        results.push({ uid, skipped: true, reason: '用户未配置 API' });
        continue;
      }

      for (const npc of byUid[uid]) {
        const { npc_id } = npc;

        // 3. 读冷却记录
        const { data: cooldownRow } = await supabase
          .from('meow_push_cooldown')
          .select('*')
          .eq('uid', uid)
          .eq('npc_id', npc_id)
          .single();

        const cd = cooldownRow || {};

        // 4. 判断触发类型
        let kind = null;

        if (isDailyWindow(now)) {
          const sentToday    = cd.last_daily_push_date === today;
          const recentlyTried = cd.last_daily_try_at &&
            (now - Number(cd.last_daily_try_at)) < 30 * 60 * 1000;
          if (!sentToday && !recentlyTried) kind = 'daily';
        }

        if (!kind && isRandomWindow(now)) {
          const lastRandom = Number(cd.last_random_push_at || 0);
          if (now - lastRandom > 2 * 60 * 60 * 1000 && Math.random() < 0.3) {
            kind = 'random';
          }
        }

        if (!kind) {
          results.push({ npc_id, skipped: true });
          continue;
        }

        // 5. 标记尝试中（防并发）
        await supabase.from('meow_push_cooldown').upsert({
          uid, npc_id,
          last_daily_try_at:    kind === 'daily' ? now : (cd.last_daily_try_at || 0),
          last_daily_push_date: cd.last_daily_push_date || '',
          last_random_push_at:  cd.last_random_push_at  || 0,
          updated_at: new Date().toISOString()
        }, { onConflict: 'uid,npc_id' });

        // 6. 用用户自己的 Key 生成消息
        let text = '';
        try {
          text = await generateMessage(npc, kind, apiCfg);
        } catch(aiErr) {
          console.warn(`[proactive] AI失败 ${npc_id}:`, aiErr.message);
          results.push({ npc_id, error: aiErr.message });
          continue;
        }

        if (!text) {
          results.push({ npc_id, error: 'AI 返回空' });
          continue;
        }

        // 消息时间戳（模拟稍早前发的）
        const offsetMin = kind === 'daily'
          ? Math.floor(Math.random() * 30) + 5
          : Math.floor(Math.random() * 10) + 2;
        const msgTs = now - offsetMin * 60 * 1000;

        // 7. 写入待拉取消息表
        await supabase.from('meow_pending_messages').insert({
          uid, npc_id, npc_name: npc.npc_name,
          text, kind, ts: msgTs, is_pulled: false
        });

        // 8. 更新冷却
        await supabase.from('meow_push_cooldown').upsert({
          uid, npc_id,
          last_daily_push_date: kind === 'daily'  ? today : (cd.last_daily_push_date || ''),
          last_daily_try_at:    kind === 'daily'  ? now   : (cd.last_daily_try_at    || 0),
          last_random_push_at:  kind === 'random' ? now   : (cd.last_random_push_at  || 0),
          updated_at: new Date().toISOString()
        }, { onConflict: 'uid,npc_id' });

        // 9. 发 Web Push 到该用户的所有设备
        const { data: devices } = await supabase
          .from('meow_devices')
          .select('*')
          .eq('uid', uid);

        let pushed = 0;
        for (const dev of (devices || [])) {
          if (await sendPush(dev, npc.npc_name, npc_id, text)) pushed++;
        }

        results.push({ npc_id, kind, pushed, preview: text.slice(0, 20) });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, total: results.length, results })
    };

  } catch(err) {
    console.error('[proactive] fatal:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(err.message || err) })
    };
  }
};
