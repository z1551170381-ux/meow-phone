// functions/api/proactive.js
// Cloudflare Pages Functions
// 用法：/api/proactive?secret=你的CRON_SECRET&force=1

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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cleanText(v, max = 400) {
  return String(v || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function pickFirst(obj, keys, max = 400) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim()) {
      return cleanText(obj[k], max);
    }
  }
  return '';
}

function normalizeTimeLabel(now) {
  const h = new Date(now).getHours();
  if (h < 5) return '深夜';
  if (h < 8) return '清晨';
  if (h < 11) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 21) return '晚上';
  return '夜里';
}

function looksLikeReservedNpc(npc) {
  const rawId = String(npc?.npc_id || '').trim().toLowerCase();
  const rawName = String(npc?.npc_name || '').trim().toLowerCase();
  if (!rawId || !rawName) return true;

  const reserved = new Set([
    'player', 'chatdetail', 'chat', 'contacts', 'discover', 'me', 'settings',
    'moments', 'forum', 'browser', 'weather', 'sms', 'calendar', 'shop',
    'map', 'home', 'phone', 'system', 'app', 'null', 'undefined'
  ]);

  if (reserved.has(rawId) || reserved.has(rawName)) return true;
  if (/^(chat|app|page|tab|view|screen)[-_:/]?[a-z0-9]*$/i.test(rawId)) return true;
  if (/^(chat|app|page|tab|view|screen)[-_:/]?[a-z0-9]*$/i.test(rawName)) return true;
  if (/开发中|construction|coming soon/i.test(String(npc?.npc_name || ''))) return true;
  return false;
}

// ========== Supabase REST ==========
async function sbSelect(env, table, filters) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?select=*`;
  for (const [k, v] of Object.entries(filters || {})) {
    url += `&${k}=eq.${encodeURIComponent(v)}`;
  }

  const resp = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`sbSelect ${table} ${resp.status}: ${errText.slice(0, 200)}`);
  }

  return await resp.json();
}

async function sbInsert(env, table, data) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(data)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`sbInsert ${table} ${resp.status}: ${errText.slice(0, 200)}`);
  }
}

async function sbUpsert(env, table, data, onConflict) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(data)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`sbUpsert ${table} ${resp.status}: ${errText.slice(0, 200)}`);
  }
}

async function sbDelete(env, table, filters) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?`;
  for (const [k, v] of Object.entries(filters || {})) {
    url += `${k}=eq.${encodeURIComponent(v)}&`;
  }

  const resp = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`sbDelete ${table} ${resp.status}: ${errText.slice(0, 200)}`);
  }
}

function buildMessageContext(npc, recentMsgs, now) {
  const timeLabel = normalizeTimeLabel(now);
  const scene = pickFirst(npc, ['current_scene', 'scene', 'scene_name', 'recent_scene'], 120);
  const location = pickFirst(npc, ['location', 'current_location', 'place', 'landmark'], 80);
  const userState = pickFirst(npc, ['user_state', 'player_state', 'persona_state'], 140);
  const npcState = pickFirst(npc, ['npc_state', 'current_state', 'status', 'doing', 'mood_state'], 140);
  const world = pickFirst(npc, ['world_book', 'worldbook', 'worldbook_text', 'world_context', 'world_summary'], 300);
  const summary = pickFirst(npc, ['summary', 'recent_summary', 'chat_summary', 'summary_text', 'timeline_summary'], 320);
  const relation = pickFirst(npc, ['relationship_note', 'bond_note', 'relation_summary'], 160);
  const memory = pickFirst(npc, ['recent_memory', 'memory', 'recent_event', 'last_topic'], 200);
  const userProfile = pickFirst(npc, ['user_profile', 'persona_profile', 'player_profile'], 180);

  return {
    timeLabel,
    scene,
    location,
    userState,
    npcState,
    world,
    summary,
    relation,
    memory,
    userProfile,
    recentMsgs: (recentMsgs || []).map(x => cleanText(x, 70)).filter(Boolean).slice(-6)
  };
}

// ========== AI ==========
async function generateMessage(npc, kind, apiCfg, ctx) {
  const { base_url, api_key, model } = apiCfg;
  if (!base_url || !api_key || !model) throw new Error('用户未配置 API');

  const bondMap = {
    '亲近': '关系较近，可以自然关心、分享细节，但不要油腻。',
    '暧昧': '允许有试探和在意，但不要像模板情话。',
    '疏远': '语气克制，避免突然过热。',
    '普通': '自然、有分寸，像平时真的会发出来的话。'
  };

  const contextBlock = [
    `【当前时段】${ctx.timeLabel}`,
    ctx.scene ? `【当前场景】${ctx.scene}` : '',
    ctx.location ? `【所在地点】${ctx.location}` : '',
    ctx.npcState ? `【角色状态】${ctx.npcState}` : '',
    ctx.userState ? `【用户状态】${ctx.userState}` : '',
    ctx.relation ? `【关系补充】${ctx.relation}` : '',
    ctx.memory ? `【最近话题/事件】${ctx.memory}` : '',
    ctx.summary ? `【聊天总结】${ctx.summary}` : '',
    ctx.world ? `【世界设定】${ctx.world}` : '',
    ctx.userProfile ? `【用户设定】${ctx.userProfile}` : '',
    ctx.recentMsgs?.length ? `【你最近发过的话】${ctx.recentMsgs.join('｜')}` : ''
  ].filter(Boolean).join('\n');

  const systemPrompt = [
    `你正在扮演「${npc.npc_name}」。`,
    npc.npc_profile ? `【角色设定】${cleanText(npc.npc_profile, 800)}` : '',
    `【关系阶段】${npc.bond || '普通'}。${bondMap[npc.bond] || bondMap['普通']}`,
    npc.online_chat_prompt ? `【聊天风格附加要求】${cleanText(npc.online_chat_prompt, 700)}` : '',
    `【主动联系原因】${kind === 'daily' ? '今天自然想起对方，顺手发一条。' : '某个瞬间联想到对方，想说一句。'}`,
    contextBlock,
    '【核心目标】写出一条像真实聊天里会突然收到的消息，而不是系统演示文案。',
    '【必须遵守】',
    '- 只输出 1 条消息，不要解释，不要引号，不要署名。',
    '- 语气要像正在进行中的关系，不要像第一次搭话。',
    '- 优先引用上面的场景、状态、总结、最近话题中的具体细节；没有细节时也要说得自然。',
    '- 禁止模板句：例如“在忙吗”“刚忙完顺便问你”“突然想起你”“你在干嘛呢”这类空泛开场。',
    '- 禁止客服腔、播报腔、打卡腔、营业腔。',
    '- 不要刻意端水式关心，不要连续问两个问题。',
    '- 字数 8-38 字优先，最多 48 字。宁可短一点，也不要像长文案。',
    '- 与最近发过的话避免同句式、同开头、同关键词重复。',
    '- 允许留白、停顿、口语感，但不要故作矫情。'
  ].filter(Boolean).join('\n');

  const userPrompt = [
    '请直接输出那条消息。',
    '它应该像这个角色本人在此刻真的会发出来的话。',
    '如果有上下文细节，就把细节自然带进去。'
  ].join('\n');

  const resp = await fetch(`${base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api_key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.95,
      presence_penalty: 0.45,
      frequency_penalty: 0.35,
      max_tokens: 120
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  return cleanText(data?.choices?.[0]?.message?.content || '', 120)
    .replace(/^(["'“”‘’「『【]+)|(["'“”‘’」』】]+)$/g, '')
    .replace(/^(在忙吗|你在干嘛|你在干什么|刚忙完|突然想起你|顺便问你)[，。！？、\s]*/i, '')
    .trim()
    .slice(0, 120);
}

// ========== Web Push utils ==========
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function b64uDec(s) {
  return Uint8Array.from(
    atob(String(s).replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );
}

async function makeVapidJWT(env, audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(new TextEncoder().encode(JSON.stringify({
    alg: 'ES256',
    typ: 'JWT'
  })));
  const claims = b64u(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: `mailto:${env.VAPID_EMAIL}`
  })));
  const input = `${header}.${claims}`;

  const d = b64uDec(env.VAPID_PRIVATE_KEY);
  const pub = b64uDec(env.VAPID_PUBLIC_KEY);

  if (d.length !== 32) {
    throw new Error(`Bad private key length: ${d.length}`);
  }
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(`Bad public key format/length: ${pub.length}`);
  }

  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: b64u(d),
    x: b64u(x),
    y: b64u(y),
    ext: true
  };

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(input)
  );

  return `${input}.${b64u(sig)}`;
}

async function sendWebPush(device, npcName, npcId, text, env) {
  try {
    const url = new URL(device.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const jwt = await makeVapidJWT(env, audience);

    const payload = JSON.stringify({
      type: 'chat_message',
      npcId,
      npcName,
      title: npcName,
      body: text,
      text,
      ts: Date.now()
    });

    const resp = await fetch(device.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
        TTL: '86400',
        Urgency: 'normal',
        'Content-Type': 'application/json'
      },
      body: payload
    });

    if (resp.status === 410 || resp.status === 404) {
      return { result: 'expired', status: resp.status, text: '' };
    }

    if (resp.ok || resp.status === 201) {
      return { result: 'ok', status: resp.status, text: '' };
    }

    const errText = await resp.text();
    console.warn('[push] status:', resp.status, errText.slice(0, 200));
    return { result: 'fail', status: resp.status, text: errText.slice(0, 200) };
  } catch (err) {
    console.warn('[push] error:', err.message);
    return { result: 'fail', status: 0, text: String(err.message || err) };
  }
}

// ========== 主流程 ==========
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const secret = url.searchParams.get('secret') || '';
  const force = url.searchParams.get('force') === '1';

  if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const now = Date.now();
  const today = todayKey(now);
  const results = [];

  try {
    const npcs = await sbSelect(env, 'meow_npc_push_config', { enable_push: true });

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
      const apiCfgList = await sbSelect(env, 'meow_user_api_config', { uid });
      const apiCfg = apiCfgList && apiCfgList[0];

      if (!apiCfg || !apiCfg.api_key) {
        results.push({ uid, skipped: true, reason: '未开启后台推送' });
        continue;
      }

      for (const npc of byUid[uid]) {
        const { npc_id } = npc;

        if (looksLikeReservedNpc(npc)) {
          results.push({ npc_id, skipped: true, reason: 'reserved-or-invalid-npc' });
          continue;
        }

        const cdList = await sbSelect(env, 'meow_push_cooldown', { uid, npc_id });
        const cd = (cdList && cdList[0]) || {};

        let kind = null;

        if (force) {
          kind = 'daily';
        } else {
          if (isDailyWindow(now)) {
            const sentToday = cd.last_daily_push_date === today;
            const recentlyTried = cd.last_daily_try_at && (now - Number(cd.last_daily_try_at)) < 30 * 60 * 1000;
            if (!sentToday && !recentlyTried) kind = 'daily';
          }

          if (!kind && isRandomWindow(now)) {
            const lastRandom = Number(cd.last_random_push_at || 0);
            if (now - lastRandom > 2 * 60 * 60 * 1000 && Math.random() < 0.3) {
              kind = 'random';
            }
          }
        }

        if (!kind) {
          results.push({ npc_id, skipped: true });
          continue;
        }

        await sbUpsert(env, 'meow_push_cooldown', {
          uid,
          npc_id,
          last_daily_try_at: kind === 'daily' ? now : (cd.last_daily_try_at || 0),
          last_daily_push_date: cd.last_daily_push_date || '',
          last_random_push_at: cd.last_random_push_at || 0,
          updated_at: new Date().toISOString()
        }, 'uid,npc_id');

        let text = '';
        try {
          const hist = await sbSelect(env, 'meow_pending_messages', { uid, npc_id });
          const recentMsgs = (hist || [])
            .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
            .map(x => x.text)
            .filter(Boolean)
            .slice(-6);
          const msgCtx = buildMessageContext(npc, recentMsgs, now);
          text = await generateMessage(npc, kind, apiCfg, msgCtx);
        } catch (aiErr) {
          results.push({ npc_id, error: aiErr.message });
          continue;
        }

        if (!text) {
          results.push({ npc_id, error: 'AI返回空' });
          continue;
        }

        const msgTs = now;

        await sbInsert(env, 'meow_pending_messages', {
          uid,
          npc_id,
          npc_name: npc.npc_name,
          text,
          kind,
          ts: msgTs,
          is_pulled: false
        });

        await sbUpsert(env, 'meow_push_cooldown', {
          uid,
          npc_id,
          last_daily_push_date: kind === 'daily' ? today : (cd.last_daily_push_date || ''),
          last_daily_try_at: kind === 'daily' ? now : (cd.last_daily_try_at || 0),
          last_random_push_at: kind === 'random' ? now : (cd.last_random_push_at || 0),
          updated_at: new Date().toISOString()
        }, 'uid,npc_id');

        const devices = await sbSelect(env, 'meow_devices', { uid });
        let pushed = 0;
        const pushDebug = [];

        for (const dev of (devices || [])) {
          const host = (() => {
            try { return new URL(dev.endpoint).host; } catch (e) { return 'bad-endpoint'; }
          })();

          const pushRes = await sendWebPush(dev, npc.npc_name, npc_id, text, env);

          pushDebug.push({
            host,
            result: pushRes.result,
            status: pushRes.status,
            text: pushRes.text,
            endpoint: String(dev.endpoint || '').slice(0, 80)
          });

          if (pushRes.result === 'expired') {
            await sbDelete(env, 'meow_devices', { endpoint: dev.endpoint });
          } else if (pushRes.result === 'ok') {
            pushed++;
          }
        }

        results.push({
          npc_id,
          kind,
          pushed,
          preview: text.slice(0, 20),
          pushDebug
        });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      total: results.length,
      results
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[proactive] fatal:', err);
    return new Response(JSON.stringify({
      ok: false,
      error: String(err.message || err)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}