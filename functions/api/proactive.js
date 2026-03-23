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
async function generateMessage(npc, kind, apiCfg, ctx) {
  const { base_url, api_key, model } = apiCfg;
  if (!base_url || !api_key || !model) throw new Error('用户未配置 API');

  const bond = npc.bond || '普通';
  const bondVibe =
    bond === '亲近' ? '你们关系很好，像老朋友，说话随意，偶尔会吐槽或撒娇，不会客气。' :
    bond === '暧昧' ? '你们之间有点说不清楚，有时候会特意找借口聊天，说话带一点隐隐的在意，但不会太明显。' :
    bond === '疏远' ? '你们不算很熟，偶尔联系，不会太热络，语气比较平。' :
                     '你们是普通朋友，正常聊天，不生硬也不过热。';

  const ctxLines = [
    '现在是' + ctx.timeLabel + '。',
    ctx.npcState    && ('你当前状态：' + ctx.npcState),
    ctx.scene       && ('场景：' + ctx.scene),
    ctx.location    && ('地点：' + ctx.location),
    ctx.userState   && ('对方现在：' + ctx.userState),
    ctx.memory      && ('你们最近聊过：' + ctx.memory),
    ctx.summary     && ('聊天记录要点：' + ctx.summary),
    ctx.world       && ('世界背景：' + ctx.world),
    ctx.userProfile && ('关于对方：' + ctx.userProfile),
    ctx.relation    && ('关系备注：' + ctx.relation),
  ].filter(Boolean).join('\n');

  // ★ 把"完整句子"约束放进 system prompt，模型更听话
  const systemPrompt = [
    '你正在扮演「' + npc.npc_name + '」，用第一人称生活着，不要跳出角色。',
    npc.npc_profile && cleanText(npc.npc_profile, 900),
    npc.online_chat_prompt && cleanText(npc.online_chat_prompt, 400),
    '',
    '【你和对方的关系】',
    bondVibe,
    ctxLines ? ('\n【此刻的状态和背景】\n' + ctxLines) : '',
    '',
    '【输出格式】',
    '你的输出就是你发给对方的一条聊天消息，只有消息本身，没有任何前缀/编号/引号/解释。',
    '这条消息必须是完整的一句话——有开头有结尾，能让对方读懂并回复。',
    '绝对不要在逗号处断开只说半截。控制在15到50个字。',
  ].filter(Boolean).join('\n');

  const historyMessages = (ctx.chatHistory || []).map(function(t) {
    return {
      role: (t.role === 'me' || t.role === 'user') ? 'user' : 'assistant',
      content: t.text
    };
  });

  const trigger = kind === 'daily'
    ? '你今天在忙自己的事，忽然想起对方——可能是看到了什么、经历了什么、或者这个时段让你想聊聊。找个符合你当下状态的真实理由，自然地发条消息给 ta。'
    : '你某个瞬间想到了对方，顺手发条消息，就像正常人刷手机时忽然想说句话一样。';

  const userPrompt = trigger
    + '\n直接输出那条消息。记住：一句完整的话，别只说半截。';

  // ─── AI 调用 ───
  async function callAI(messages) {
    const resp = await fetch(base_url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + api_key },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.85,
        presence_penalty: 0.3,
        frequency_penalty: 0.3,
        max_tokens: 300,
      })
    });
    if (!resp.ok) throw new Error('AI ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
    const data = await resp.json();
    return String(
      data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content || ''
    ).trim();
  }

  // ─── 清洗 ───
  function postProcess(raw) {
    var s = raw.trim();
    // 多行 → 取第一段有中文的
    var lines = s.split(/[\n\r]+/).map(function(l) { return l.trim(); }).filter(Boolean);
    if (lines.length > 1) {
      s = '';
      for (var i = 0; i < lines.length; i++) {
        if (/[\u4e00-\u9fff]/.test(lines[i])) { s = lines[i]; break; }
      }
      if (!s) s = lines[0];
    }
    // 去英文前缀 Draft 1 (Food): 等
    s = s.replace(/^(draft|option|version|choice|message|note)\s*\d*\s*(\([^)]*\))?\s*[:\uff1a\-\*]\s*/i, '');
    // 去编号 1. / 1) / - / * 等
    s = s.replace(/^[\(\uff08]?\d+[\)\uff09.\uff0e]?\s*/, '');
    s = s.replace(/^[-\*\u2022\u25cf]\s*/, '');
    // 去中文前缀
    s = s.replace(/^(消息|回复|内容|正文|发送|我说|我发|我的消息|草稿|备选)\s*\d*\s*[\uff1a:]\s*/, '');
    // 去首尾引号/星号/空白
    s = s.replace(/^[\*"'\u201c\u201d\u2018\u2019\u300c\u300e\s]+|[\*"'\u201c\u201d\u2018\u2019\u300d\u300f\s]+$/g, '');
    // 合并空白
    s = s.replace(/[\n\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return s.slice(0, 200);
  }

  // ─── 质量检测（宽松版：只拦截明确的垃圾） ───
  function isBadOutput(t) {
    if (!t || t.replace(/\s/g, '').length < 4) return true;
    // 无中文
    if (!/[\u4e00-\u9fff]/.test(t)) return true;
    // 英文前缀残留
    if (/^(draft|option|version)/i.test(t.trim())) return true;
    // 以逗号、省略号等明确的"未完待续"标点结尾
    if (/[\uff0c\u3001\uff1a\uff1b,;:]$/.test(t.trim())) return true;
    return false;
  }

  // ─── 半句检测（用于触发补全而非直接拒绝） ───
  function looksIncomplete(t) {
    var s = t.trim();
    // ★ 先排除：如果以语气词/标点自然结尾，不可能是半截话
    if (/[了吧啊呢吗呀哦嘛哈嗯噢啦喔耶诶咯捏滴。！？!?~～)）」』]$/.test(s)) return false;
    // 以"看到""翻到""听到""发现""想到"等动词结尾 → 缺宾语
    if (/[\u770b\u542c\u7ffb\u53d1\u60f3\u627e\u5230]$/.test(s)) return true;
    // 以"一个""一张""一种""一些""那个"等量词短语结尾
    if (/[\u4e00\u90a3\u8fd9][\u4e2a\u5f20\u79cd\u4e9b\u53ea\u5757\u676f\u7247]$/.test(s)) return true;
    // 以"的""在"结尾且较短
    if (/[\u7684\u5728]$/.test(s) && s.length < 20) return true;
    // ★ 感知动词 + 1~3字短名词结尾（如"看到货架""看到路边""翻到照片"）
    if (/(看到|听到|翻到|碰到|遇到|发现|注意到|路过|经过).{1,3}$/.test(s)) return true;
    return false;
  }

  // ─── 补全半句话：把半截话喂回模型让它说完 ───
  async function repairIncomplete(halfText) {
    try {
      var raw = await callAI([
        { role: 'system', content: systemPrompt },
        { role: 'assistant', content: halfText },
        { role: 'user', content: '你这句话没说完，请把这条消息说完整。直接输出完整的那条消息，不要加其他内容。' }
      ]);
      var cleaned = postProcess(raw);
      // 补全结果仍然要过基础检查
      if (cleaned && cleaned.replace(/\s/g, '').length >= 4 && /[\u4e00-\u9fff]/.test(cleaned)) {
        return cleaned;
      }
    } catch (_) {}
    return '';
  }

  // ─── 主流程：生成 → 检测 → 补全 → 兜底 ───
  var candidates = [];
  var mainMessages = [
    { role: 'system', content: systemPrompt }
  ].concat(historyMessages).concat([
    { role: 'user', content: userPrompt }
  ]);

  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var raw = await callAI(mainMessages);
      var cleaned = postProcess(raw);
      console.log('[proactive] attempt ' + (attempt + 1) + ': "' + cleaned.slice(0, 60) + '"');

      // 明确的垃圾 → 跳过
      if (isBadOutput(cleaned)) {
        console.warn('[proactive] attempt ' + (attempt + 1) + ' rejected (bad): ' + raw.slice(0, 80));
        continue;
      }

      // 看起来不完整 → 尝试补全
      if (looksIncomplete(cleaned)) {
        console.log('[proactive] attempt ' + (attempt + 1) + ' incomplete, repairing...');
        var repaired = await repairIncomplete(cleaned);
        if (repaired && !isBadOutput(repaired)) {
          console.log('[proactive] repaired: "' + repaired.slice(0, 60) + '"');
          return repaired;
        }
        // 补全失败，存为候选
        candidates.push(cleaned);
        continue;
      }

      // 通过全部检查 → 直接返回
      return cleaned;
    } catch (e) {
      console.error('[proactive] attempt ' + (attempt + 1) + ' error:', e.message);
      if (attempt === 2) throw e;
    }
  }

  // ★ 兜底：如果有候选（半截话），取最长的那条而不是返回空
  // 因为半截话虽然不完美，但总比完全不推送好
  if (candidates.length > 0) {
    candidates.sort(function(a, b) { return b.length - a.length; });
    console.log('[proactive] fallback to best candidate: "' + candidates[0].slice(0, 60) + '"');
    return candidates[0];
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

        if (!text) { results.push({ npc_id, error: 'AI返回空' }); continue; }

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
