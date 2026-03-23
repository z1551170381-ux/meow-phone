// functions/api/proactive.js  —  Cloudflare Pages Functions
// /api/proactive?secret=CRON_SECRET&force=1

// ─────────── 时间工具 ───────────
function isDailyWindow(now)  { const h = new Date(now).getHours(); return h >= 10 && h <= 22; }
function isRandomWindow(now) { const h = new Date(now).getHours(); return h >= 8  && h <= 23; }
function todayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function normalizeTimeLabel(now) {
  const h = new Date(now).getHours();
  if (h < 5)  return '\u6df1\u591c';
  if (h < 8)  return '\u6e05\u6668';
  if (h < 11) return '\u4e0a\u5348';
  if (h < 14) return '\u4e2d\u5348';
  if (h < 18) return '\u4e0b\u5348';
  if (h < 21) return '\u665a\u4e0a';
  return '\u591c\u91cc';
}

function cleanText(v, max) {
  return String(v || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 400);
}

function pickFirst(obj, keys, max) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim())
      return cleanText(obj[k], max || 400);
  }
  return '';
}

// ─────────── NPC 过滤 ───────────
function looksLikeReservedNpc(npc) {
  const rawId   = String(npc && npc.npc_id   || '').trim().toLowerCase();
  const rawName = String(npc && npc.npc_name || '').trim().toLowerCase();
  if (!rawId || !rawName) return true;
  const reserved = new Set([
    'player','chatdetail','chat','contacts','discover','me','settings',
    'moments','forum','browser','weather','sms','calendar','shop',
    'map','home','phone','system','app','null','undefined'
  ]);
  if (reserved.has(rawId) || reserved.has(rawName)) return true;
  if (/^(chat|app|page|tab|view|screen)[-_:/]?[a-z0-9]*$/i.test(rawId))   return true;
  if (/^(chat|app|page|tab|view|screen)[-_:/]?[a-z0-9]*$/i.test(rawName)) return true;
  return false;
}

// ─────────── Supabase REST ───────────
async function sbSelect(env, table, filters, extra) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?select=*`;
  for (const k of Object.keys(filters || {}))
    url += `&${k}=eq.${encodeURIComponent(filters[k])}`;
  if (extra) url += extra;
  const r = await fetch(url, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!r.ok) throw new Error(`sbSelect ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

async function sbInsert(env, table, data) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', apikey:env.SUPABASE_SERVICE_KEY,
               Authorization:`Bearer ${env.SUPABASE_SERVICE_KEY}`, Prefer:'return=minimal' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`sbInsert ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
}

async function sbUpsert(env, table, data, onConflict) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', apikey:env.SUPABASE_SERVICE_KEY,
               Authorization:`Bearer ${env.SUPABASE_SERVICE_KEY}`, Prefer:'resolution=merge-duplicates' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`sbUpsert ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
}

async function sbDelete(env, table, filters) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?`;
  for (const k of Object.keys(filters || {})) url += `${k}=eq.${encodeURIComponent(filters[k])}&`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { apikey:env.SUPABASE_SERVICE_KEY, Authorization:`Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!r.ok) throw new Error(`sbDelete ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
}

async function fetchRecentChatHistory(env, uid, npcId, limit) {
  try {
    const rows = await sbSelect(env, 'meow_chat_history', { uid, npc_id: npcId },
      `&order=ts.desc&limit=${limit || 14}`);
    if (!Array.isArray(rows) || !rows.length) return [];
    return rows.reverse()
      .map(r => ({ role: String(r.role || 'npc'), text: cleanText(r.text || r.content || '', 120) }))
      .filter(r => r.text);
  } catch (_) { return []; }
}

function buildMessageContext(npc, chatHistory, now) {
  return {
    timeLabel:   normalizeTimeLabel(now),
    scene:       pickFirst(npc, ['current_scene','scene','scene_name','recent_scene'], 120),
    location:    pickFirst(npc, ['location','current_location','place','landmark'], 80),
    userState:   pickFirst(npc, ['user_state','player_state','persona_state'], 140),
    npcState:    pickFirst(npc, ['npc_state','current_state','status','doing','mood_state'], 140),
    world:       pickFirst(npc, ['world_book','worldbook','worldbook_text','world_context','world_summary'], 300),
    summary:     pickFirst(npc, ['summary','recent_summary','chat_summary','summary_text','timeline_summary'], 320),
    relation:    pickFirst(npc, ['relationship_note','bond_note','relation_summary'], 160),
    memory:      pickFirst(npc, ['recent_memory','memory','recent_event','last_topic'], 200),
    userProfile: pickFirst(npc, ['user_profile','persona_profile','player_profile'], 180),
    chatHistory: chatHistory || []
  };
}

// ─────────── AI 生成 ───────────
// ─────────── AI 生成 ───────────
async function generateMessage(npc, kind, apiCfg, ctx) {
  const { base_url, api_key, model } = apiCfg;
  if (!base_url || !api_key || !model) throw new Error('用户未配置 API');

  const bond = npc.bond || '普通';
  const bondVibe =
    bond === '亲近' ? '你们关系亲近，说话自然熟稔，可以带一点关心和生活感，但不要油腻。' :
    bond === '暧昧' ? '你们之间有点特别的在意，说话可以柔和一点、留一点试探，但不要越界表白。' :
    bond === '疏远' ? '你们不算熟，偶尔联系，语气克制，不要突然过热。' :
                     '你们是正常来往的关系，说话自然、有分寸，不生硬也不过热。';

  const ctxLines = [
    '现在是' + ctx.timeLabel + '。',
    ctx.npcState    && ('你当前：' + ctx.npcState),
    ctx.scene       && ('场景：' + ctx.scene),
    ctx.location    && ('地点：' + ctx.location),
    ctx.userState   && ('对方现在：' + ctx.userState),
    ctx.memory      && ('你们最近聊过：' + ctx.memory),
    ctx.summary     && ('聊天要点：' + ctx.summary),
    ctx.world       && ('背景：' + ctx.world),
    ctx.userProfile && ('关于对方：' + ctx.userProfile),
    ctx.relation    && ('关系备注：' + ctx.relation),
  ].filter(Boolean).join('\n');

  const systemPrompt = [
    '你正在扮演「' + npc.npc_name + '」，此刻要主动给对方发一条即时聊天消息。',
    npc.npc_profile ? cleanText(npc.npc_profile, 900) : '',
    npc.online_chat_prompt ? cleanText(npc.online_chat_prompt, 500) : '',
    '',
    '【你和对方的关系】',
    bondVibe,
    ctxLines ? ('\n【此刻的状态和背景】\n' + ctxLines) : '',
    '',
    '【任务】',
    '基于你现在的状态、你们最近的聊天内容、关系远近、世界背景与眼前具体情境，发一句自然找对方说话的话。',
    '',
    '【硬性要求】',
    '1. 只输出一条消息正文，不要解释，不要编号，不要草稿标签，不要 Scene / Draft / Option / Tone / Setting 这类英文提示词。',
    '2. 必须是一句完整的话，像真实聊天，不要只停在“看到”“想到”“路过”“发现”这种半截动作上。',
    '3. 字数尽量控制在 15 到 25 个中文字符左右，最多不超过 32 个中文字符。',
    '4. 这句话必须像“在找对方说话”，而不是只描写一个画面或物品。',
    '5. 优先从具体细节切入：眼前看到的东西、刚发生的事、此刻的状态、最近聊过的话题。',
    '6. 不要用模板句：如“在忙吗”“突然想起你”“顺手问问你”“刚空下来一点”。',
    '7. 关系普通或疏远时，不要说得过分亲密；关系亲近或暧昧时，也不要油腻。',
    '8. 如果写不出自然完整的一句话，就只输出：__SKIP__'
  ].filter(Boolean).join('\n');

  const historyMessages = (ctx.chatHistory || []).map(function(t) {
    return {
      role: (t.role === 'me' || t.role === 'user') ? 'user' : 'assistant',
      content: String(t.text || '')
    };
  }).filter(function(x) {
    return x.content.trim();
  }).slice(-8);

  const trigger = kind === 'daily'
    ? '你今天一直在忙自己的事，此刻因为一个具体的小事或眼前的细节，想起了对方，于是自然地发一句。'
    : '你在某个瞬间被一个具体细节触发，想到对方，于是顺手发一句。';

  const userPrompt = [
    trigger,
    '',
    '直接输出你要发的那一句消息。',
    '这句话必须是完整句。',
    '这句话要像在主动找对方说话。',
    '这句话不要只剩半句，也不要变成英文标签或草稿标题。',
    '如果只能写出半句、模板句、提示词片段，就输出 __SKIP__ 。'
  ].join('\n');

  async function callAI(extraHint) {
    const resp = await fetch(base_url + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + api_key
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt }
        ].concat(historyMessages).concat([
          { role: 'user', content: userPrompt + (extraHint ? ('\n' + extraHint) : '') }
        ]),
        temperature: 0.82,
        presence_penalty: 0.28,
        frequency_penalty: 0.22,
        max_tokens: 180
      })
    });

    if (!resp.ok) {
      throw new Error('AI ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
    }

    const data = await resp.json();
    return String(
      data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content || ''
    ).trim();
  }

  function postProcess(raw) {
    let s = String(raw || '').trim();

    // 多行时优先取第一条像聊天正文的内容
    const lines = s.split(/[\r\n]+/).map(function(l) { return l.trim(); }).filter(Boolean);
    if (lines.length > 1) {
      s = '';
      for (var i = 0; i < lines.length; i++) {
        if (/[\u4e00-\u9fff]/.test(lines[i])) {
          s = lines[i];
          break;
        }
      }
      if (!s) s = lines[0];
    }

    s = s
      .replace(/^(draft|option|version|choice|message|scene|tone|setting)\s*\d*\s*(\([^)]*\))?\s*[:：\-*]\s*/i, '')
      .replace(/^[\(\uff08]?\d+[\)\uff09.\uff0e]?\s*/, '')
      .replace(/^[-*•●]\s*/, '')
      .replace(/^(消息|回复|内容|正文|发送|我说|我发|草稿)\s*[\d一二三四五六七八九十]*\s*[:：]\s*/, '')
      .replace(/^[\*"'\u201c\u201d\u2018\u2019\u300c\u300e\s]+|[\*"'\u201c\u201d\u2018\u2019\u300d\u300f\s]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return s.slice(0, 80);
  }

  function hasChinese(t) {
    return /[\u4e00-\u9fff]/.test(String(t || ''));
  }

  function looksIncomplete(t) {
    var s = String(t || '').trim();
    if (!s) return true;
    if (s.length < 8) return true;

    // 这些结尾明显没说完
    if (/(看到|想到|发现|路过|经过|翻到|闻到|买到|看见|刚在|刚从|刚路过|然后|结果)$/.test(s)) return true;
    if (/[，、：；—…·,;:\-]$/.test(s)) return true;

    // 没有正常句尾，而且又很短
    var terminalPunct = /[。！？!?~～」』”’》）)]$/.test(s);
    var naturalEnding = /[了吧啊呢吗呀哦嘛哈啦喔哇诶耶噢的呀呀]$/.test(s);
    if (!terminalPunct && !naturalEnding && s.length < 18) return true;

    return false;
  }

  function looksTemplate(t) {
    var s = String(t || '').trim();

    if (/^(在忙吗|你在干嘛|突然想起你|顺手问问你|刚空下来一点)/.test(s)) return true;
    if (/^(Scene|Draft|Option|Tone|Setting)\b/i.test(s)) return true;
    if (/^(刚刚|刚才|刚在|刚从|刚路过).{0,10}(看到|想到|发现)$/.test(s)) return true;

    return false;
  }

  function lengthOK(t) {
    var s = String(t || '').replace(/\s/g, '');
    return s.length >= 10 && s.length <= 36;
  }

  async function tryOnce(extraHint) {
    var raw = await callAI(extraHint);
    var cleaned = postProcess(raw);

    if (!cleaned) return '';
    if (cleaned === '__SKIP__') return '';
    if (!hasChinese(cleaned)) return '';
    if (looksTemplate(cleaned)) return '';
    if (looksIncomplete(cleaned)) return '';
    if (!lengthOK(cleaned)) return '';

    return cleaned;
  }

  const retryHints = [
    '',
    '重写一次：只写一句完整的话，15到25字左右，像在主动找对方说话，不要停在“看到”“想到”“路过”上。',
    '再重写一次：必须是一句能直接发给对方的完整聊天句子，别写画面碎片，别写英文标签。'
  ];

  for (let i = 0; i < retryHints.length; i++) {
    try {
      const text = await tryOnce(retryHints[i]);
      if (text) return text;
    } catch (e) {
      if (i === retryHints.length - 1) throw e;
    }
  }

  return '';
}

// ─────────── Web Push 工具 ───────────
function b64u(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64uDec(s) {
  const str = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}
function concatU8() {
  const arrays = Array.prototype.slice.call(arguments);
  let total = 0;
  for (let i = 0; i < arrays.length; i++) total += arrays[i].length;
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < arrays.length; i++) { out.set(arrays[i], off); off += arrays[i].length; }
  return out;
}

async function makeVapidJWT(env, audience) {
  const now    = Math.floor(Date.now() / 1000);
  const enc    = new TextEncoder();
  const header = b64u(enc.encode(JSON.stringify({ alg:'ES256', typ:'JWT' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud:audience, exp:now+43200, sub:`mailto:${env.VAPID_EMAIL}` })));
  const input  = header + '.' + claims;
  const d      = b64uDec(env.VAPID_PRIVATE_KEY);
  const pub    = b64uDec(env.VAPID_PUBLIC_KEY);
  if (d.length !== 32)                      throw new Error('Bad VAPID private key length: ' + d.length);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('Bad VAPID public key format');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty:'EC', crv:'P-256', d:b64u(d), x:b64u(pub.slice(1,33)), y:b64u(pub.slice(33,65)), ext:true },
    { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, enc.encode(input));
  return input + '.' + b64u(sig);
}

// RFC 8291 aes128gcm 加密（Apple Web Push 强制要求）
async function encryptPayload(plaintextStr, p256dhB64u, authB64u) {
  const enc        = new TextEncoder();
  const clientPub  = b64uDec(p256dhB64u);
  const authSecret = b64uDec(authB64u);

  const serverKP   = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const clientKey  = await crypto.subtle.importKey('raw', clientPub, { name:'ECDH', namedCurve:'P-256' }, false, []);
  const sharedBits = new Uint8Array(await crypto.subtle.deriveBits({ name:'ECDH', public:clientKey }, serverKP.privateKey, 256));
  const serverPub  = new Uint8Array(await crypto.subtle.exportKey('raw', serverKP.publicKey));
  const salt       = crypto.getRandomValues(new Uint8Array(16));

  async function hkdf(ikm, saltBytes, info, len) {
    const k = await crypto.subtle.importKey('raw', ikm, { name:'HKDF' }, false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name:'HKDF', hash:'SHA-256', salt:saltBytes, info: info }, k, len * 8
    ));
  }

  const prk   = await hkdf(sharedBits, authSecret,
    concatU8(enc.encode('WebPush: info\x00'), clientPub, serverPub), 32);
  const cek   = await hkdf(prk, salt, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(prk, salt, enc.encode('Content-Encoding: nonce\x00'), 12);

  const aesKey     = await crypto.subtle.importKey('raw', cek, { name:'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name:'AES-GCM', iv:nonce }, aesKey,
    concatU8(enc.encode(plaintextStr), new Uint8Array([2]))
  ));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false); // big-endian 4096

  return concatU8(salt, rs, new Uint8Array([serverPub.length]), serverPub, ciphertext);
}

async function sendWebPush(device, npcName, npcId, text, env) {
  try {
    const url      = new URL(device.endpoint);
    const audience = url.protocol + '//' + url.host;
    const jwt      = await makeVapidJWT(env, audience);
    const payload  = JSON.stringify({ type:'chat_message', npcId, npcName, title:npcName, body:text, text, ts:Date.now() });

    const headers = {
      Authorization: 'vapid t=' + jwt + ',k=' + env.VAPID_PUBLIC_KEY,
      TTL: '86400',
      Urgency: 'normal'
    };

    let body;
    if (device.p256dh && device.auth) {
      body = await encryptPayload(payload, device.p256dh, device.auth);
      headers['Content-Type']     = 'application/octet-stream';
      headers['Content-Encoding'] = 'aes128gcm';
    } else {
      headers['Content-Length'] = '0';
    }

    const resp = await fetch(device.endpoint, { method:'POST', headers, body: body || undefined });
    if (resp.status === 410 || resp.status === 404) return { result:'expired', status:resp.status, text:'' };
    if (resp.ok || resp.status === 201)             return { result:'ok',      status:resp.status, text:'' };
    const err = await resp.text();
    return { result:'fail', status:resp.status, text:err.slice(0,200) };
  } catch (err) {
    return { result:'fail', status:0, text:String(err.message || err) };
  }
}

// ─────────── 主流程 ───────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';
  const force  = url.searchParams.get('force') === '1';

  if (env.CRON_SECRET && secret !== env.CRON_SECRET) return new Response('Unauthorized', { status:401 });

  const now = Date.now(), today = todayKey(now), results = [];

  try {
    const npcs = await sbSelect(env, 'meow_npc_push_config', { enable_push: true });
    if (!npcs || !npcs.length) {
      return new Response(JSON.stringify({ ok:true, msg:'暂无角色配置' }), { headers:{'Content-Type':'application/json'} });
    }

    const byUid = {};
    for (const npc of npcs) { byUid[npc.uid] = byUid[npc.uid] || []; byUid[npc.uid].push(npc); }

    for (const uid of Object.keys(byUid)) {
      const apiCfgList = await sbSelect(env, 'meow_user_api_config', { uid });
      const apiCfg = apiCfgList && apiCfgList[0];
      if (!apiCfg || !apiCfg.api_key) { results.push({ uid, skipped:true, reason:'未开启后台推送' }); continue; }

      for (const npc of byUid[uid]) {
        const { npc_id } = npc;
        if (looksLikeReservedNpc(npc)) { results.push({ npc_id, skipped:true, reason:'reserved' }); continue; }

        const cdList = await sbSelect(env, 'meow_push_cooldown', { uid, npc_id });
        const cd = (cdList && cdList[0]) || {};

        let kind = null;
        if (force) {
          kind = 'daily';
        } else {
          if (isDailyWindow(now)) {
            const sentToday     = cd.last_daily_push_date === today;
            const recentlyTried = cd.last_daily_try_at && (now - Number(cd.last_daily_try_at)) < 30*60*1000;
            if (!sentToday && !recentlyTried) kind = 'daily';
          }
          if (!kind && isRandomWindow(now)) {
            if (now - Number(cd.last_random_push_at || 0) > 2*60*60*1000 && Math.random() < 0.3) kind = 'random';
          }
        }

        if (!kind) { results.push({ npc_id, skipped:true }); continue; }

        await sbUpsert(env, 'meow_push_cooldown', {
          uid, npc_id,
          last_daily_try_at:    kind === 'daily'  ? now : (cd.last_daily_try_at || 0),
          last_daily_push_date: cd.last_daily_push_date || '',
          last_random_push_at:  cd.last_random_push_at  || 0,
          updated_at: new Date().toISOString()
        }, 'uid,npc_id');

        let text = '';
        try {
          const chatHistory = await fetchRecentChatHistory(env, uid, npc_id, 14);
          text = await generateMessage(npc, kind, apiCfg, buildMessageContext(npc, chatHistory, now));
        } catch (aiErr) { results.push({ npc_id, error: aiErr.message }); continue; }

        if (!text) {
  results.push({ npc_id, skipped: true, reason: 'no-complete-message' });
  continue;
}

        await sbInsert(env, 'meow_pending_messages', {
          uid, npc_id, npc_name: npc.npc_name, text, kind, ts: now, is_pulled: false
        });

        await sbUpsert(env, 'meow_push_cooldown', {
          uid, npc_id,
          last_daily_push_date: kind === 'daily'  ? today : (cd.last_daily_push_date || ''),
          last_daily_try_at:    kind === 'daily'  ? now   : (cd.last_daily_try_at    || 0),
          last_random_push_at:  kind === 'random' ? now   : (cd.last_random_push_at  || 0),
          updated_at: new Date().toISOString()
        }, 'uid,npc_id');

        const devices = await sbSelect(env, 'meow_devices', { uid });
        let pushed = 0;
        const pushDebug = [];

        for (const dev of (devices || [])) {
          const host = (function() { try { return new URL(dev.endpoint).host; } catch(_) { return 'bad-endpoint'; } })();
          const res  = await sendWebPush(dev, npc.npc_name, npc_id, text, env);
          pushDebug.push({ host, result:res.result, status:res.status, text:res.text,
            endpoint: String(dev.endpoint || '').slice(0, 80), encrypted: !!(dev.p256dh && dev.auth) });
          if (res.result === 'expired') await sbDelete(env, 'meow_devices', { endpoint: dev.endpoint });
          else if (res.result === 'ok') pushed++;
        }

        results.push({ npc_id, kind, pushed, preview: text.slice(0, 20), pushDebug });
      }
    }

    return new Response(JSON.stringify({ ok:true, total:results.length, results }), {
      headers: { 'Content-Type':'application/json' }
    });

  } catch (err) {
    console.error('[proactive] fatal:', err);
    return new Response(JSON.stringify({ ok:false, error:String(err.message || err) }), {
      status:500, headers:{'Content-Type':'application/json'}
    });
  }
}
