// functions/api/proactive.js — Cloudflare Pages Functions (v4 — 定时推送版)
// 由 cron 定期调用（每 2~5 分钟一次）
// ★ 不再调 AI API，不再存 API Key
// ★ 只检查 meow_scheduled_push 表中到时间的消息，发 Web Push

// ─────────── Supabase REST ───────────

function sbHeaders(env) {
  return {
    'Content-Type': 'application/json',
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
}

async function sbSelect(env, table, extra) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?select=*${extra || ''}`;
  const r = await fetch(url, { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`sbSelect ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}

async function sbPatch(env, table, filters, data) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?`;
  for (const k of Object.keys(filters)) url += `${k}=eq.${encodeURIComponent(filters[k])}&`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: sbHeaders(env),
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`sbPatch ${table} ${r.status}`);
}

async function sbInsert(env, table, data) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`sbInsert ${table} ${r.status}: ${(await r.text()).slice(0,200)}`);
}

async function sbDelete(env, table, filters) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?`;
  for (const k of Object.keys(filters)) url += `${k}=eq.${encodeURIComponent(filters[k])}&`;
  await fetch(url, { method: 'DELETE', headers: sbHeaders(env) });
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
  if (d.length !== 32) throw new Error('Bad VAPID private key');
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('Bad VAPID public key');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty:'EC', crv:'P-256', d:b64u(d), x:b64u(pub.slice(1,33)), y:b64u(pub.slice(33,65)), ext:true },
    { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, enc.encode(input));
  return input + '.' + b64u(sig);
}

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
    return new Uint8Array(await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt:saltBytes, info }, k, len * 8));
  }
  const prk   = await hkdf(sharedBits, authSecret, concatU8(enc.encode('WebPush: info\x00'), clientPub, serverPub), 32);
  const cek   = await hkdf(prk, salt, enc.encode('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(prk, salt, enc.encode('Content-Encoding: nonce\x00'), 12);
  const aesKey     = await crypto.subtle.importKey('raw', cek, { name:'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv:nonce }, aesKey,
    concatU8(enc.encode(plaintextStr), new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concatU8(salt, rs, new Uint8Array([serverPub.length]), serverPub, ciphertext);
}

async function sendWebPush(device, npcName, npcId, text, env) {
  try {
    const url      = new URL(device.endpoint);
    const audience = url.protocol + '//' + url.host;
    const jwt      = await makeVapidJWT(env, audience);
    const payload  = JSON.stringify({
      type: 'chat_message', npcId, npcName,
      title: npcName, body: text, text: text,
      ts: Date.now()
    });
    const headers = {
      Authorization: 'vapid t=' + jwt + ',k=' + env.VAPID_PUBLIC_KEY,
      TTL: '86400', Urgency: 'normal'
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
    if (resp.status === 410 || resp.status === 404) return { result:'expired', status:resp.status };
    if (resp.ok || resp.status === 201)             return { result:'ok',      status:resp.status };
    return { result:'fail', status:resp.status, text:(await resp.text()).slice(0,200) };
  } catch (err) {
    return { result:'fail', status:0, text:String(err.message || err) };
  }
}

// ─────────── 主流程 ───────────

export async function onRequestGet(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';

  if (env.CRON_SECRET && secret !== env.CRON_SECRET)
    return new Response('Unauthorized', { status: 401 });

  const now = new Date().toISOString();
  const results = [];

  try {
    // ── 查找所有到时间、未发送、未取消的消息 ──
    const pending = await sbSelect(env, 'meow_scheduled_push',
      `&is_sent=eq.false&is_cancelled=eq.false&push_at=lte.${encodeURIComponent(now)}&order=push_at.asc&limit=20`
    );

    if (!pending || !pending.length) {
      return jsonResp({ ok: true, msg: '无待发消息', total: 0 });
    }

    for (const msg of pending) {
      const { id, uid, npc_id, npc_name, text } = msg;

      // 获取该用户的设备
      const devices = await sbSelect(env, 'meow_devices', `&uid=eq.${encodeURIComponent(uid)}`);
      let pushed = 0;

      for (const dev of (devices || [])) {
        const res = await sendWebPush(dev, npc_name, npc_id, text, env);
        if (res.result === 'expired') {
          await sbDelete(env, 'meow_devices', { endpoint: dev.endpoint });
        } else if (res.result === 'ok') {
          pushed++;
        }
      }

      // 标记为已发送
      const patchUrl = `${env.SUPABASE_URL}/rest/v1/meow_scheduled_push?id=eq.${encodeURIComponent(id)}`;
      await fetch(patchUrl, {
        method: 'PATCH',
        headers: sbHeaders(env),
        body: JSON.stringify({ is_sent: true, sent_at: new Date().toISOString() })
      });

      // 也存到 pending_messages 供前端拉取
      try {
        await sbInsert(env, 'meow_pending_messages', {
          uid, npc_id, npc_name, text, kind: 'bgpush', ts: Date.now(), is_pulled: false
        });
      } catch(e) {}

      results.push({ id, npc_id, npc_name, pushed, preview: text.slice(0, 30), batch_id: msg.batch_id || null });
    }

    // ── 清理：删除 7 天前的已发送/已取消记录 ──
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const cleanUrl = `${env.SUPABASE_URL}/rest/v1/meow_scheduled_push?created_at=lt.${encodeURIComponent(cutoff)}&or=(is_sent.eq.true,is_cancelled.eq.true)`;
      await fetch(cleanUrl, { method: 'DELETE', headers: sbHeaders(env) });
    } catch(e) {}

    return jsonResp({ ok: true, total: results.length, results });

  } catch (err) {
    console.error('[proactive] fatal:', err);
    return jsonResp({ ok: false, error: String(err.message || err) }, 500);
  }
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
