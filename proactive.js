// functions/api/proactive.js
// Cloudflare Pages Functions - 完整版，带加密 payload 的 Web Push

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
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ========== Supabase REST ==========
async function sbSelect(env, table, filters) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?select=*`;
  for (const [k, v] of Object.entries(filters || {})) {
    url += `&${k}=eq.${encodeURIComponent(v)}`;
  }
  const resp = await fetch(url, {
    headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!resp.ok) throw new Error(`sbSelect ${table} ${resp.status}`);
  return resp.json();
}

async function sbUpsert(env, table, data, onConflict) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(data)
  });
  if (!resp.ok) throw new Error(`sbUpsert ${table}: ${(await resp.text()).slice(0,100)}`);
}

async function sbInsert(env, table, data) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
  if (!resp.ok) throw new Error(`sbInsert ${table}: ${(await resp.text()).slice(0,100)}`);
}

async function sbDelete(env, table, filters) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?`;
  for (const [k, v] of Object.entries(filters)) url += `${k}=eq.${encodeURIComponent(v)}&`;
  await fetch(url, { method: 'DELETE', headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` } });
}

// ========== AI 生成消息 ==========
async function generateMessage(npc, kind, apiCfg) {
  const { base_url, api_key, model } = apiCfg;
  if (!api_key || !base_url || !model) throw new Error('用户未配置 API');

  const bondMap = { '亲近':'可以更自然地关心和分享。', '暧昧':'可以带一点试探和在意。', '疏远':'语气要克制一点。', '普通':'保持自然、有分寸。' };
  const kindLabel = kind === 'daily' ? '在今天的间隙里想起了你' : '突然想起你了';

  const systemPrompt = [
    `你正在扮演「${npc.npc_name}」。`,
    npc.npc_profile || '',
    `【关系阶段】${npc.bond || '普通'}。${bondMap[npc.bond] || bondMap['普通']}`,
    npc.online_chat_prompt ? `【附加要求】${npc.online_chat_prompt}` : '',
    `【行为背景】你${kindLabel}，想主动联系用户。`,
    `【输出要求】只发1条消息，1-3句，60字以内。不要引号，不要解释。`
  ].filter(Boolean).join('\n');

  const resp = await fetch(`${base_url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api_key}` },
    body: JSON.stringify({ model, messages: [{ role:'system', content:systemPrompt }, { role:'user', content:'（请直接输出那条消息）' }], temperature:0.9, max_tokens:100 })
  });
  if (!resp.ok) throw new Error(`AI ${resp.status}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || '').trim().replace(/^["「『【]|["」』】]$/g, '').slice(0, 120);
}

// ========== Web Push 工具函数 ==========
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function b64uDec(s) {
  return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
}

function derToJose(signature) {
  const sig = signature instanceof Uint8Array ? signature : new Uint8Array(signature);

  if (sig[0] !== 0x30) {
    throw new Error('Invalid DER signature');
  }

  let offset = 2;
  if (sig[1] & 0x80) {
    offset = 2 + (sig[1] & 0x7f);
  }

  if (sig[offset] !== 0x02) {
    throw new Error('Invalid DER signature (missing r)');
  }

  const rLen = sig[offset + 1];
  let r = sig.slice(offset + 2, offset + 2 + rLen);
  offset = offset + 2 + rLen;

  if (sig[offset] !== 0x02) {
    throw new Error('Invalid DER signature (missing s)');
  }

  const sLen = sig[offset + 1];
  let s = sig.slice(offset + 2, offset + 2 + sLen);

  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);

  const rOut = new Uint8Array(32);
  const sOut = new Uint8Array(32);
  rOut.set(r, 32 - r.length);
  sOut.set(s, 32 - s.length);

  const out = new Uint8Array(64);
  out.set(rOut, 0);
  out.set(sOut, 32);
  return out;
}

async function makeVapidJWT(env, audience) {
  const now = Math.floor(Date.now()/1000);
  const header = b64u(new TextEncoder().encode(JSON.stringify({ alg:'ES256', typ:'JWT' })));
  const claims = b64u(new TextEncoder().encode(JSON.stringify({ aud:audience, exp:now+3600, sub:`mailto:${env.VAPID_EMAIL}` })));
  const input = `${header}.${claims}`;

  const rawKeyBytes = b64uDec(env.VAPID_PRIVATE_KEY);
  const pkcs8Header = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04,
    0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20
  ]);
  const pkcs8Key = new Uint8Array(pkcs8Header.length + rawKeyBytes.length);
  pkcs8Key.set(pkcs8Header);
  pkcs8Key.set(rawKeyBytes, pkcs8Header.length);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Key,
    { name:'ECDSA', namedCurve:'P-256' },
    false,
    ['sign']
  );

  const derSig = await crypto.subtle.sign(
    { name:'ECDSA', hash:'SHA-256' },
    key,
    new TextEncoder().encode(input)
  );

  const joseSig = derToJose(new Uint8Array(derSig));
  return `${input}.${b64u(joseSig)}`;
}
async function makeVapidJWT(env, audience) {
  const now = Math.floor(Date.now()/1000);
  const header = b64u(new TextEncoder().encode(JSON.stringify({ alg:'ES256', typ:'JWT' })));
  const claims = b64u(new TextEncoder().encode(JSON.stringify({ aud:audience, exp:now+3600, sub:`mailto:${env.VAPID_EMAIL}` })));
  const input = `${header}.${claims}`;

  const rawKeyBytes = b64uDec(env.VAPID_PRIVATE_KEY);
  const pkcs8Header = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04,
    0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20
  ]);
  const pkcs8Key = new Uint8Array(pkcs8Header.length + rawKeyBytes.length);
  pkcs8Key.set(pkcs8Header);
  pkcs8Key.set(rawKeyBytes, pkcs8Header.length);

  const key = await crypto.subtle.importKey('pkcs8', pkcs8Key, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
const derSig = await crypto.subtle.sign(
  { name:'ECDSA', hash:'SHA-256' },
  key,
  new TextEncoder().encode(input)
);

const joseSig = derToJose(new Uint8Array(derSig));
return `${input}.${b64u(joseSig)}`;
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function encryptPayload(device, payloadStr) {
  const plaintext = new TextEncoder().encode(payloadStr);

  const receiverPubKey = await crypto.subtle.importKey(
    'raw', b64uDec(device.p256dh),
    { name:'ECDH', namedCurve:'P-256' }, false, []
  );

  const senderKeyPair = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey','deriveBits']);
  const senderPubKeyRaw = await crypto.subtle.exportKey('raw', senderKeyPair.publicKey);

  const sharedBits = await crypto.subtle.deriveBits({ name:'ECDH', public: receiverPubKey }, senderKeyPair.privateKey, 256);
  const authSecret = b64uDec(device.auth);
  const prk = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);

  const authInfo = new TextEncoder().encode('Content-Encoding: auth\0');
  const ikmBits = await crypto.subtle.deriveBits(
    { name:'HKDF', hash:'SHA-256', salt: authSecret, info: authInfo }, prk, 256
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikmBits, 'HKDF', false, ['deriveBits']);
  const senderPubBytes = new Uint8Array(senderPubKeyRaw);
  const receiverPubBytes = b64uDec(device.p256dh);

  const keyInfo = concat([
    new TextEncoder().encode('Content-Encoding: aesgcm\0'),
    new Uint8Array([0, 65]), senderPubBytes,
    new Uint8Array([0, 65]), receiverPubBytes
  ]);
  const nonceInfo = concat([
    new TextEncoder().encode('Content-Encoding: nonce\0'),
    new Uint8Array([0, 65]), senderPubBytes,
    new Uint8Array([0, 65]), receiverPubBytes
  ]);

  const contentKey = await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info: keyInfo }, ikmKey, 128);
  const nonceBits  = await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info: nonceInfo }, ikmKey, 96);

  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const padded = concat([new Uint8Array([0, 0]), plaintext]);
  const ciphertext = await crypto.subtle.encrypt({ name:'AES-GCM', iv: nonceBits }, aesKey, padded);

  return {
    ciphertext: new Uint8Array(ciphertext),
    salt,
    senderPubKey: senderPubBytes
  };
}

async function sendWebPush(device, npcName, npcId, text, env) {
  try {
    const url = new URL(device.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const jwt = await makeVapidJWT(env, audience);

    const resp = await fetch(device.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
        'TTL': '86400',
        'Urgency': 'normal',
        'Topic': `meow-${String(npcId || 'msg').slice(0, 32)}`
      }
    });

    if (resp.status === 410 || resp.status === 404) return 'expired';
    if (resp.ok || resp.status === 201) return 'ok';

    const errText = await resp.text();
    console.warn('[push] status:', resp.status, errText.slice(0, 200));
    return 'fail';
  } catch (err) {
    console.warn('[push] error:', err.message);
    return 'fail';
  }
}

// ========== 主流程 ==========
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';
  if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const now = Date.now();
  const today = todayKey(now);
  const results = [];

  try {
    const npcs = await sbSelect(env, 'meow_npc_push_config', { enable_push: true });
    if (!npcs || npcs.length === 0) {
      return new Response(JSON.stringify({ ok:true, msg:'暂无角色配置' }), { headers:{'Content-Type':'application/json'} });
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
        results.push({ uid, skipped:true, reason:'未开启后台推送' });
        continue;
      }

      for (const npc of byUid[uid]) {
        const { npc_id } = npc;
        const cdList = await sbSelect(env, 'meow_push_cooldown', { uid, npc_id });
        const cd = (cdList && cdList[0]) || {};

        let kind = null;
        if (isDailyWindow(now)) {
          const sentToday     = cd.last_daily_push_date === today;
          const recentlyTried = cd.last_daily_try_at && (now - Number(cd.last_daily_try_at)) < 30*60*1000;
          if (!sentToday && !recentlyTried) kind = 'daily';
        }
        if (!kind && isRandomWindow(now)) {
          const lastRandom = Number(cd.last_random_push_at || 0);
          if (now - lastRandom > 2*60*60*1000 && Math.random() < 0.3) kind = 'random';
        }
        if (!kind) {
          results.push({ npc_id, skipped:true });
          continue;
        }

        await sbUpsert(env, 'meow_push_cooldown', {
          uid, npc_id,
          last_daily_try_at:    kind==='daily' ? now : (cd.last_daily_try_at||0),
          last_daily_push_date: cd.last_daily_push_date||'',
          last_random_push_at:  cd.last_random_push_at||0,
          updated_at: new Date().toISOString()
        }, 'uid,npc_id');

        let text = '';
        try {
          text = await generateMessage(npc, kind, apiCfg);
        } catch(aiErr) {
          results.push({ npc_id, error:aiErr.message });
          continue;
        }
        if (!text) {
          results.push({ npc_id, error:'AI返回空' });
          continue;
        }

        const msgTs = now;
        await sbInsert(env, 'meow_pending_messages', {
          uid,
          npc_id,
          npc_name:npc.npc_name,
          text,
          kind,
          ts:msgTs,
          is_pulled:false
        });

        await sbUpsert(env, 'meow_push_cooldown', {
          uid, npc_id,
          last_daily_push_date: kind==='daily'  ? today : (cd.last_daily_push_date||''),
          last_daily_try_at:    kind==='daily'  ? now   : (cd.last_daily_try_at||0),
          last_random_push_at:  kind==='random' ? now   : (cd.last_random_push_at||0),
          updated_at: new Date().toISOString()
        }, 'uid,npc_id');

        const devices = await sbSelect(env, 'meow_devices', { uid });
let pushed = 0;
const pushDebug = [];

for (const dev of (devices || [])) {
  const host = (() => {
    try { return new URL(dev.endpoint).host; } catch(e) { return 'bad-endpoint'; }
  })();

  const r = await sendWebPush(dev, npc.npc_name, npc_id, text, env);

  pushDebug.push({
  host,
  result: r,
  endpoint: dev.endpoint.slice(0, 60)
});

  if (r === 'expired') {
    await sbDelete(env, 'meow_devices', { endpoint: dev.endpoint });
  } else if (r === 'ok') {
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

    return new Response(JSON.stringify({ ok:true, total:results.length, results }), {
      headers:{'Content-Type':'application/json'}
    });
  } catch(err) {
    console.error('[proactive] fatal:', err);
    return new Response(JSON.stringify({ ok:false, error:String(err.message||err) }), {
      status:500,
      headers:{'Content-Type':'application/json'}
    });
  }
}