// functions/api/proactive.js  —  Cloudflare Pages Functions
// 用法：/api/proactive?secret=你的CRON_SECRET&force=1
//
// ★ v3 修复：
//   - RFC 8291 aes128gcm 加密两处 bug：
//       1) PRK 推导的 HKDF salt 必须是 authSecret，不是随机 salt
//       2) record size 字节序：4096 大端序 = [0x00, 0x00, 0x10, 0x00]（上版写反了）
//   - AI 上下文：对话历史作为 messages 多轮注入；从 meow_chat_history 读真实记录

// ─────────── 时间工具 ───────────
function isDailyWindow(now)  { const h = new Date(now).getHours(); return h >= 10 && h <= 22; }
function isRandomWindow(now) { const h = new Date(now).getHours(); return h >= 8  && h <= 23; }

function todayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function normalizeTimeLabel(now) {
  const h = new Date(now).getHours();
  if (h < 5)  return '深夜';
  if (h < 8)  return '清晨';
  if (h < 11) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 21) return '晚上';
  return '夜里';
}

// ─────────── 文本工具 ───────────
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
    if (obj && obj[k] != null && String(obj[k]).trim())
      return cleanText(obj[k], max);
  }
  return '';
}

// ─────────── NPC 过滤 ───────────
function looksLikeReservedNpc(npc) {
  const rawId   = String(npc?.npc_id   || '').trim().toLowerCase();
  const rawName = String(npc?.npc_name || '').trim().toLowerCase();
  if (!rawId || !rawName) return true;
  const reserved = new Set([
    'player','chatdetail','chat','contacts','discover','me','settings',
    'moments','forum','browser','weather','sms','calendar','shop',
    'map','home','phone','system','app','null','undefined'
  ]);
  if (reserved.has(rawId) || reserved.has(rawName)) return true;
  if (/^(chat|app|page|tab|view|screen)[-_:/]?[a-z0-9]*$/i.test(rawId))   return true;
  if (/^(chat|app|page|tab|view|screen)[-_:/]?[a-z0-9]*$/i.test(rawName)) return true;
  if (/开发中|construction|coming soon/i.test(String(npc?.npc_name || ''))) return true;
  return false;
}

// ─────────── Supabase REST ───────────
async function sbSelect(env, table, filters, extra = '') {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?select=*`;
  for (const [k, v] of Object.entries(filters || {}))
    url += `&${k}=eq.${encodeURIComponent(v)}`;
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
    headers: { 'Content-Type':'application/json', apikey:env.SUPABASE_SERVICE_KEY, Authorization:`Bearer ${env.SUPABASE_SERVICE_KEY}`, Prefer:'return=minimal' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`sbInsert ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
}

async function sbUpsert(env, table, data, onConflict) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', apikey:env.SUPABASE_SERVICE_KEY, Authorization:`Bearer ${env.SUPABASE_SERVICE_KEY}`, Prefer:'resolution=merge-duplicates' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`sbUpsert ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
}

async function sbDelete(env, table, filters) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?`;
  for (const [k, v] of Object.entries(filters || {})) url += `${k}=eq.${encodeURIComponent(v)}&`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { apikey:env.SUPABASE_SERVICE_KEY, Authorization:`Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!r.ok) throw new Error(`sbDelete ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
}

// ─────────── 真实对话历史 ───────────
async function fetchRecentChatHistory(env, uid, npcId, limit = 14) {
  try {
    const rows = await sbSelect(env, 'meow_chat_history', { uid, npc_id: npcId }, `&order=ts.desc&limit=${limit}`);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    return rows.reverse()
      .map(r => ({ role: String(r.role || 'npc'), text: cleanText(r.text || r.content || '', 120) }))
      .filter(r => r.text);
  } catch (_) { return []; }
}

// ─────────── 上下文构建 ───────────
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
async function generateMessage(npc, kind, apiCfg, ctx) {
  const { base_url, api_key, model } = apiCfg;
  if (!base_url || !api_key || !model) throw new Error('用户未配置 API');

  const bondMap = {
    '亲近': '关系较近，自然关心、分享细节，语气真实但不油腻。',
    '暧昧': '有试探和在意，带一点心意但不要像模板情话。',
    '疏远': '语气克制，不突然过热，也不太客气。',
    '普通': '自然有分寸，像平时真的会发出来的话。'
  };

  // ── 上下文块（只放信息，不放指令）──
  const contextLines = [
    `时段：${ctx.timeLabel}`,
    ctx.scene       && `场景：${ctx.scene}`,
    ctx.location    && `地点：${ctx.location}`,
    ctx.npcState    && `角色状态：${ctx.npcState}`,
    ctx.userState   && `对方状态：${ctx.userState}`,
    ctx.relation    && `关系补充：${ctx.relation}`,
    ctx.memory      && `最近话题：${ctx.memory}`,
    ctx.summary     && `聊天总结：${ctx.summary}`,
    ctx.world       && `世界设定：${ctx.world}`,
    ctx.userProfile && `对方设定：${ctx.userProfile}`,
  ].filter(Boolean).join('\n');

  // ── system prompt：角色 + 上下文，不写字数规则（避免模型把规则当输出）──
  const systemPrompt = [
    `你是「${npc.npc_name}」，用第一人称直接发一条微信消息给对方。`,
    npc.npc_profile && `角色设定：${cleanText(npc.npc_profile, 800)}`,
    `与对方的关系：${npc.bond || '普通'}（${bondMap[npc.bond] || bondMap['普通']}）`,
    npc.online_chat_prompt && `风格要求：${cleanText(npc.online_chat_prompt, 600)}`,
    contextLines ? `\n当前上下文：\n${contextLines}` : '',
  ].filter(Boolean).join('\n');

  // ── 对话历史注入 ──
  const historyMessages = (ctx.chatHistory || []).map(turn => ({
    role: (turn.role === 'me' || turn.role === 'user') ? 'user' : 'assistant',
    content: turn.text
  }));

  // ── user prompt：简单直接，触发角色输出，避免指令泄漏 ──
  const kindHint = kind === 'daily'
    ? '（今天忽然想发一条，可以是你的事、看到的东西、或任何自然涌现的话）'
    : '（某个瞬间想到对方，随手发一句）';
  const userPrompt = `现在以「${npc.npc_name}」的身份，主动给对方发一条消息${kindHint}。\n只输出消息正文，不加任何解释或前缀。`;

  async function callAI() {
    const resp = await fetch(`${base_url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.92,
        presence_penalty: 0.45,
        frequency_penalty: 0.35,
        max_tokens: 80  // 消息本来就短，80 token 足够且可减少废话
      })
    });
    if (!resp.ok) throw new Error(`AI ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    return cleanText(data?.choices?.[0]?.message?.content || '', 120);
  }

  // ── 输出校验：识别模型把指令/规则当内容输出的情况 ──
  function looksLikeLeakedInstruction(text) {
    if (!text || text.length < 2) return true;
    // 纯 ASCII（含"50 max"、"max tokens"等）且无中文 → 大概率是英文系统噪音
    if (/^[\x00-\x7F\s]+$/.test(text) && !/[\u4e00-\u9fff]/.test(text)) return true;
    // 明显是把规则/指令当内容输出
    const badPatterns = [
      /^(字数|max|token|output|response|message|只输出|不要|禁止|角色|设定|系统|关系)/i,
      /^\d+\s*(max|字|tokens?)/i,
      /^(【|您好|你好|Hi|Hello|Sure|Okay|Of course)/i,
    ];
    for (const p of badPatterns) if (p.test(text.trim())) return true;
    return false;
  }

  let text = '';
  // 最多重试 2 次
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await callAI();
      const cleaned = raw
        .replace(/^["'"""''「『【\s]+|["'"""''」』】\s]+$/g, '')
        .replace(/^(在忙吗|你在干嘛|你在干什么|刚忙完|突然想起你|顺便问你|最近怎么样)[，。！？、\s]*/i, '')
        .trim();
      if (!looksLikeLeakedInstruction(cleaned) && cleaned.length >= 4) {
        text = cleaned.slice(0, 100);
        break;
      }
      console.warn(`[proactive] attempt ${attempt+1} bad output: "${cleaned.slice(0,30)}"`);
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }

  return text;
}

// ─────────── Web Push 工具 ───────────
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function b64uDec(s) {
  return Uint8Array.from(atob(String(s).replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
}
function concatU8(...arrays) {
  const out = new Uint8Array(arrays.reduce((s,a)=>s+a.length, 0));
  let off = 0; for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function makeVapidJWT(env, audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(new TextEncoder().encode(JSON.stringify({ alg:'ES256', typ:'JWT' })));
  const claims = b64u(new TextEncoder().encode(JSON.stringify({ aud:audience, exp:now+43200, sub:`mailto:${env.VAPID_EMAIL}` })));
  const input  = `${header}.${claims}`;
  const d   = b64uDec(env.VAPID_PRIVATE_KEY);
  const pub = b64uDec(env.VAPID_PUBLIC_KEY);
  if (d.length !== 32)                      throw new Error(`Bad VAPID private key length: ${d.length}`);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error(`Bad VAPID public key format`);
  const key = await crypto.subtle.importKey(
    'jwk', { kty:'EC', crv:'P-256', d:b64u(d), x:b64u(pub.slice(1,33)), y:b64u(pub.slice(33,65)), ext:true },
    { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64u(sig)}`;
}

// ★ RFC 8291 aes128gcm 正确实现
// 修复两处 bug（相较于 v2）：
//   1) PRK 的 HKDF salt = authSecret（不是随机 salt）
//   2) record size = 4096 = [0x00, 0x00, 0x10, 0x00]（大端序，v2 写成了 [0x00,0x10,0x00,0x00]）
async function encryptPayload(plaintextStr, p256dhB64u, authB64u) {
  const enc        = new TextEncoder();
  const clientPub  = b64uDec(p256dhB64u); // 65 bytes uncompressed P-256 public key
  const authSecret = b64uDec(authB64u);   // 16 bytes auth secret

  // 1. 生成服务端临时 ECDH 密钥对
  const serverKP = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);

  // 2. 导入客户端公钥
  const clientKey = await crypto.subtle.importKey('raw', clientPub, { name:'ECDH', namedCurve:'P-256' }, false, []);

  // 3. ECDH 共享密钥
  const sharedBits = new Uint8Array(await crypto.subtle.deriveBits({ name:'ECDH', public:clientKey }, serverKP.privateKey, 256));

  // 4. 导出服务端公钥（raw, 65 bytes）
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKP.publicKey));

  // 5. 随机 16 字节 salt（用于 aes128gcm record header 和 CEK/Nonce 的 HKDF）
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // ── HKDF 辅助（注意：salt 参数按调用方传入，不共用） ──
  async function hkdf(ikmBytes, saltBytes, infoBytes, lengthBytes) {
    const k = await crypto.subtle.importKey('raw', ikmBytes, { name:'HKDF' }, false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name:'HKDF', hash:'SHA-256', salt:saltBytes, info:infoBytes },
      k, lengthBytes * 8
    ));
  }

  // 6. ★ PRK_key: HKDF(salt=authSecret, IKM=sharedSecret, info="WebPush: info\0"||clientPub||serverPub)
  const prk = await hkdf(
    sharedBits,
    authSecret,  // ← salt = authSecret（v2 的 bug：用了随机 salt）
    concatU8(enc.encode('WebPush: info\x00'), clientPub, serverPubRaw),
    32
  );

  // 7. CEK: HKDF(salt=randomSalt, IKM=prk, info="Content-Encoding: aes128gcm\0", 16 bytes)
  const cek = await hkdf(prk, salt, enc.encode('Content-Encoding: aes128gcm\x00'), 16);

  // 8. Nonce: HKDF(salt=randomSalt, IKM=prk, info="Content-Encoding: nonce\0", 12 bytes)
  const nonce = await hkdf(prk, salt, enc.encode('Content-Encoding: nonce\x00'), 12);

  // 9. AES-GCM 加密（plaintext + 0x02 padding delimiter）
  const aesKey    = await crypto.subtle.importKey('raw', cek, { name:'AES-GCM' }, false, ['encrypt']);
  const plainPad  = concatU8(enc.encode(plaintextStr), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv:nonce }, aesKey, plainPad));

  // 10. 组装 RFC 8291 aes128gcm record：
  //   salt(16) + record_size(4, big-endian=4096) + keyid_len(1) + keyid(serverPub,65) + ciphertext
  // ★ 4096 大端序 = [0x00, 0x00, 0x10, 0x00]（v2 的 bug：写成了 [0x00,0x10,0x00,0x00] = 1048576）
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false); // big-endian

  return concatU8(salt, rs, new Uint8Array([serverPubRaw.length]), serverPubRaw, ciphertext);
}

async function sendWebPush(device, npcName, npcId, text, env) {
  try {
    const url      = new URL(device.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const jwt      = await makeVapidJWT(env, audience);

    const payloadJson = JSON.stringify({ type:'chat_message', npcId, npcName, title:npcName, body:text, text, ts:Date.now() });

    const headers = {
      Authorization: `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      TTL: '86400',
      Urgency: 'normal',
    };

    let body;
    if (device.p256dh && device.auth) {
      body = await encryptPayload(payloadJson, device.p256dh, device.auth);
      headers['Content-Type']     = 'application/octet-stream';
      headers['Content-Encoding'] = 'aes128gcm';
    } else {
      // 无加密密钥时发空 body ping，触发 SW 主动 pull
      headers['Content-Length'] = '0';
    }

    const resp = await fetch(device.endpoint, { method:'POST', headers, body: body || undefined });

    if (resp.status === 410 || resp.status === 404) return { result:'expired', status:resp.status, text:'' };
    if (resp.ok || resp.status === 201)             return { result:'ok',      status:resp.status, text:'' };

    const errText = await resp.text();
    console.warn('[push] status:', resp.status, errText.slice(0,200));
    return { result:'fail', status:resp.status, text:errText.slice(0,200) };
  } catch (err) {
    console.warn('[push] error:', err.message);
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
    if (!npcs || npcs.length === 0) {
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

        if (looksLikeReservedNpc(npc)) { results.push({ npc_id, skipped:true, reason:'reserved-or-invalid-npc' }); continue; }

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
            if (now - Number(cd.last_random_push_at||0) > 2*60*60*1000 && Math.random() < 0.3) kind = 'random';
          }
        }

        if (!kind) { results.push({ npc_id, skipped:true }); continue; }

        await sbUpsert(env, 'meow_push_cooldown', {
          uid, npc_id,
          last_daily_try_at:    kind==='daily'  ? now : (cd.last_daily_try_at||0),
          last_daily_push_date: cd.last_daily_push_date || '',
          last_random_push_at:  cd.last_random_push_at  || 0,
          updated_at: new Date().toISOString()
        }, 'uid,npc_id');

        let text = '';
        try {
          const chatHistory = await fetchRecentChatHistory(env, uid, npc_id, 14);
          text = await generateMessage(npc, kind, apiCfg, buildMessageContext(npc, chatHistory, now));
        } catch (aiErr) { results.push({ npc_id, error:aiErr.message }); continue; }

        if (!text) { results.push({ npc_id, error:'AI返回空' }); continue; }

        await sbInsert(env, 'meow_pending_messages', { uid, npc_id, npc_name:npc.npc_name, text, kind, ts:now, is_pulled:false });

        await sbUpsert(env, 'meow_push_cooldown', {
          uid, npc_id,
          last_daily_push_date: kind==='daily'  ? today : (cd.last_daily_push_date||''),
          last_daily_try_at:    kind==='daily'  ? now   : (cd.last_daily_try_at   ||0),
          last_random_push_at:  kind==='random' ? now   : (cd.last_random_push_at ||0),
          updated_at: new Date().toISOString()
        }, 'uid,npc_id');

        const devices = await sbSelect(env, 'meow_devices', { uid });
        let pushed = 0;
        const pushDebug = [];

        for (const dev of (devices || [])) {
          const host    = (() => { try { return new URL(dev.endpoint).host; } catch { return 'bad-endpoint'; } })();
          const pushRes = await sendWebPush(dev, npc.npc_name, npc_id, text, env);
          pushDebug.push({ host, result:pushRes.result, status:pushRes.status, text:pushRes.text,
            endpoint: String(dev.endpoint||'').slice(0,80), encrypted:!!(dev.p256dh && dev.auth) });
          if (pushRes.result === 'expired') await sbDelete(env, 'meow_devices', { endpoint:dev.endpoint });
          else if (pushRes.result === 'ok') pushed++;
        }

        results.push({ npc_id, kind, pushed, preview:text.slice(0,20), pushDebug });
      }
    }

    return new Response(JSON.stringify({ ok:true, total:results.length, results }), { headers:{'Content-Type':'application/json'} });

  } catch (err) {
    console.error('[proactive] fatal:', err);
    return new Response(JSON.stringify({ ok:false, error:String(err.message||err) }), { status:500, headers:{'Content-Type':'application/json'} });
  }
}
