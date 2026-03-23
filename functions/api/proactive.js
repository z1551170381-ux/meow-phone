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
  const scene = pickFirst(npc, ['current_scene', 'scene', 'scene_name', 'recent_scene'], 180);
  const location = pickFirst(npc, ['location', 'current_location', 'place', 'landmark'], 120);
  const userState = pickFirst(npc, ['user_state', 'player_state', 'persona_state'], 240);
  const npcState = pickFirst(npc, ['npc_state', 'current_state', 'status', 'doing', 'mood_state'], 240);
  const world = pickFirst(npc, ['world_book', 'worldbook', 'worldbook_text', 'world_context', 'world_summary'], 600);
  const summary = pickFirst(npc, ['summary', 'recent_summary', 'chat_summary', 'summary_text', 'timeline_summary'], 700);
  const relation = pickFirst(npc, ['relationship_note', 'bond_note', 'relation_summary'], 240);
  const memory = pickFirst(npc, ['recent_memory', 'memory', 'recent_event', 'last_topic'], 320);
  const userProfile = pickFirst(npc, ['user_profile', 'persona_profile', 'player_profile'], 260);

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
    recentMsgs: (recentMsgs || []).map(x => cleanText(x, 90)).filter(Boolean).slice(-6)
  };
}

function looksIncompleteMessage(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.length < 10) return true;
  if (/[，、：；（(]$/.test(s)) return true;
  if (!/[。！？!?~～…]$/.test(s) && s.length <= 18) return true;
  return false;
}

function looksTemplateMessage(text) {
  const s = String(text || '').trim();
  if (!s) return true;

  const badPatterns = [
    /^在忙吗[。！!？?]?$/i,
    /^你在干嘛[呢吗]?[。！!？?]?$/i,
    /^突然想起你[了啦呀]?[。！!？?]?$/i,
    /^顺手问问你[。！!？?]?$/i,
    /^刚空下来一点/i,
    /^就想来和你说句话/i,
    /^刚才在/i,
    /^刚从.+出来[，。！!？?]?$/i,
    /^楼下那家/i,
    /^刚路过/i
  ];

  if (badPatterns.some(re => re.test(s))) return true;
  if (/想起你|说句话|来找你|顺手问问你/.test(s) && s.length <= 24) return true;

  return false;
}

// ========== AI ==========
async function generateMessage(npc, kind, apiCfg, ctx) {
  const { base_url, api_key, model } = apiCfg;
  if (!base_url || !api_key || !model) throw new Error('用户未配置 API');

  const bondMap = {
    '亲近': '你们已经比较熟，允许自然关心、分享当下、轻微依赖，但不要油腻。',
    '暧昧': '你对对方有在意和试探，语气可以更柔和，但不要直接越界。',
    '普通': '你们有来往，但还没到特别亲密的程度，语气自然、有分寸。',
    '疏远': '你们距离感更明显，语气克制，不要突然热络或说不符合关系的话。'
  };

  function sanitizeOutput(raw) {
    let text = String(raw || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return '';

    text = text
      .replace(/^(["'“”‘’「『【]+)|(["'“”‘’」』】]+)$/g, '')
      .replace(/^(阿文|对方|角色|NPC)\s*[:：]\s*/i, '')
      .trim();

    return text.slice(0, 160);
  }

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
    ctx.recentMsgs?.length ? `【你最近几次主动发过的话】${ctx.recentMsgs.join('｜')}` : ''
  ].filter(Boolean).join('\n');

  const systemPrompt = [
    `你正在扮演「${npc.npc_name}」给用户发一条主动消息。`,
    npc.npc_profile ? `【角色设定】${cleanText(npc.npc_profile, 1200)}` : '',
    `【关系阶段】${npc.bond || '普通'}。${bondMap[npc.bond] || bondMap['普通']}`,
    npc.online_chat_prompt ? `【聊天风格附加要求】${cleanText(npc.online_chat_prompt, 900)}` : '',
    `【主动联系背景】${kind === 'daily' ? '这是今天自然发生的一次主动联系。' : '这是一个偶然瞬间引发的主动联系。'}`,
    contextBlock,
    '【你的任务】',
    '基于角色设定、关系、最近聊天总结、世界观、状态和此刻情境，写一条像真实聊天里会突然收到的主动消息。',
    '这条消息应该像角色本人在生活里自然想到用户，于是顺手说一句，而不是系统模板或客服文案。',
    '【写法要求】',
    '1. 优先从具体细节里找话题，比如地点、场景、状态、刚发生的事、最近聊过的话题。',
    '2. 关系普通或疏远时，不要突然过分亲密；关系亲近或暧昧时，也不要油腻。',
    '3. 像即时聊天，不像旁白，不像通知播报。',
    '4. 允许自然问候，但必须符合角色个性和关系远近，不能像客服开场白。',
    '【输出要求】',
    '- 只输出消息正文，不要解释，不要引号，不要署名。',
    '- 只写 1 句完整的话；优先 20-56 字，最多 80 字。',
    '- 这句话必须是完整句，单独显示在通知里也成立。',
    '- 必须自然收尾，优先用句号、问号、感叹号、波浪号结尾。',
    '- 不要写成半句，不要只剩一个画面或一个短语。',
    '- 不要写成这些模板：如“在忙吗”“突然想起你”“顺手问问你”“刚空下来一点”。',
    '- 如果实在写不出自然完整的话，就只返回：__SKIP__'
  ].join('\n');

  const userPrompt = [
    '直接输出那条消息。',
    '让它看起来像角色此刻真的会发出来的话。',
    '优先使用上下文里的具体细节，自然把话题带出来。',
    '必须是完整句，不能是残句。'
  ].join('\n');

  async function runOnce(extraHint) {
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
          { role: 'user', content: userPrompt + (extraHint ? '\n' + extraHint : '') }
        ],
        temperature: 0.82,
        presence_penalty: 0.28,
        frequency_penalty: 0.22,
        max_tokens: 180
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`AI ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    return sanitizeOutput(data?.choices?.[0]?.message?.content || '');
  }

  let text = await runOnce('');

  if (text === '__SKIP__') return '';
  if (!text || looksIncompleteMessage(text) || looksTemplateMessage(text)) {
    text = await runOnce('重写一次：这次必须写成完整句，不能残句，不能只停在半截场景上，不能模板化。');
  }

  if (text === '__SKIP__') return '';
  if (!text || looksIncompleteMessage(text) || looksTemplateMessage(text)) return '';

  return sanitizeOutput(text);
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
    const endpoint = String(device && device.endpoint || '').trim();
    if (!endpoint) {
      return { result: 'fail', status: 0, text: 'empty-endpoint' };
    }

    const url = new URL(endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const jwt = await makeVapidJWT(env, audience);
    const host = String(url.host || '').toLowerCase();
    const isApple = /(^|\.)web\.push\.apple\.com$/.test(host);

    async function postOnce(headersObj) {
      return await fetch(endpoint, {
        method: 'POST',
        headers: headersObj
      });
    }

    let resp;

    if (isApple) {
      resp = await postOnce({
        Authorization: `WebPush ${jwt}`,
        'Crypto-Key': `p256ecdsa=${env.VAPID_PUBLIC_KEY}`,
        TTL: '86400',
        Urgency: 'normal'
      });

      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        try {
          const retryResp = await postOnce({
            Authorization: `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
            'Crypto-Key': `p256ecdsa=${env.VAPID_PUBLIC_KEY}`,
            TTL: '86400',
            Urgency: 'normal'
          });
          resp = retryResp;
        } catch (retryErr) {}
      }
    } else {
      resp = await postOnce({
        Authorization: `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
        TTL: '86400',
        Urgency: 'normal'
      });
    }

    if (resp.status === 410 || resp.status === 404) {
      return { result: 'expired', status: resp.status, text: '' };
    }

    if (resp.ok || resp.status === 201) {
      return { result: 'ok', status: resp.status, text: '' };
    }

    const errText = await resp.text();
    console.warn('[push] status:', resp.status, errText.slice(0, 200), 'host=', host);
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
          results.push({ npc_id, skipped: true, reason: 'empty-message' });
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
          fullText: text,
          textLength: String(text || '').length,
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