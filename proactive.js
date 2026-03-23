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
    '亲近': '你们已经比较熟，允许自然关心、分享当下、轻微撒娇或依赖，但不要油腻。',
    '暧昧': '你对对方有在意和试探，语气可以更柔和、更留神分寸，不要直接越界表白。',
    '普通': '你们有来往、有印象，但还没有到过分亲密的程度，语气自然、有分寸。',
    '疏远': '你们距离感更明显，语气克制一点，不要突然热络或说不符合关系的话。'
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

    return text.slice(0, 140);
  }

  function looksBad(text) {
    const s = String(text || '').trim();
    if (!s) return true;

    if (s.length < 8) return true;
    if (/[，、：；（(]$/.test(s)) return true;

    const badPatterns = [
      /^在忙吗[。！!？?]?$/i,
      /^你在干嘛[呢吗]?[。！!？?]?$/i,
      /^突然想起你[了啦呀]?[。！!？?]?$/i,
      /^顺手问问你[。！!？?]?$/i,
      /^刚空下来一点[，。！!？?]?/i,
      /^就想来和你说句话[。！!？?]?$/i,
      /^楼下那家/i,
      /^刚才在/i,
      /^刚从.+出来[，。！!？?]?$/i
    ];

    return badPatterns.some(re => re.test(s));
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
    npc.npc_profile ? `【角色设定】${cleanText(npc.npc_profile, 1000)}` : '',
    `【关系阶段】${npc.bond || '普通'}。${bondMap[npc.bond] || bondMap['普通']}`,
    npc.online_chat_prompt ? `【聊天风格附加要求】${cleanText(npc.online_chat_prompt, 800)}` : '',
    `【此刻为何会主动联系】${kind === 'daily' ? '这是今天自然发生的一次主动联系。' : '这是一个偶然瞬间引发的主动联系。'}`,
    contextBlock,
    '【你的任务】',
    '基于角色设定、关系阶段、最近聊天总结、世界观、当前状态和此刻情境，写一条像真实聊天里会突然收到的主动消息。',
    '这条消息应该像角色本人在生活里自然想起用户，于是顺手说一句，而不是系统模板或客服文案。',
    '【写法要求】',
    '1. 先吸收资料，再说话。不要无视上面的设定和上下文。',
    '2. 优先从“此刻具体发生的事”里找话题，比如地点、场景、状态、刚看到的东西、最近聊过的事。',
    '3. 如果具体细节不多，也可以发轻一点的问候或起话题，但仍要符合角色性格和关系远近。',
    '4. 不要说不符合关系的话。关系普通或疏远时，不要突然过分亲密；关系亲近或暧昧时，也不要油腻。',
    '5. 像即时聊天，不像文学旁白，不像通知播报。',
    '【输出要求】',
    '- 只输出消息正文，不要解释，不要引号，不要署名。',
    '- 优先 1 句，也允许 2 句短句；整体控制在 18-60 字，最多 80 字。',
    '- 语气自然，有生活感，可以有一点停顿和口语感。',
    '- 不要故意写残句，不要只剩半句话。',
    '- 不要写成这些模板：如“在忙吗”“突然想起你”“顺手问问你”“刚空下来一点”。',
    '- 不要连续追问两个问题，不要客服腔，不要广播腔。'
  ].join('\n');

  const userPrompt = [
    '直接输出那条消息。',
    '让它看起来像角色此刻真的会发出来的话。',
    '优先使用上下文里的具体细节，自然地把话题带出来。'
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
        temperature: 0.88,
        presence_penalty: 0.35,
        frequency_penalty: 0.28,
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

  if (looksBad(text)) {
    text = await runOnce('重写一次：更像真实聊天，带一点具体情境，不要模板句，不要残句。');
  }

  return sanitizeOutput(text);
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

        if (!text) {
  results.push({ npc_id, skipped: true, reason: 'empty-message' });
  continue;
}

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
