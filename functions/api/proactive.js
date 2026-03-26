// functions/api/proactive.js — v2.1 Step 3+4
// 完整调度链路：
//   1. 过期扫描
//   2. 查 planned + 到时间的消息
//   3. 每条消息逐一判断：勿扰？超上限？会话状态×标签？
//   4. 通过 → sent，不通过 → skipped + skip_reason

// ─────────── 好感区间 → 每轮上限 ───────────
// affinity → max pushes per batch round
function getMaxPushes(affinity) {
  if (affinity < -30) return 0;
  if (affinity < 10)  return 1;
  if (affinity < 40)  return 2;
  if (affinity < 60)  return 3;
  if (affinity < 80)  return 4;
  return 5;
}

// ─────────── 会话状态推导 ───────────
// 返回: 'unread' | 'read_no_reply' | 'read_replied' | 'no_push_yet'
function deriveSessionState(cfg) {
  const sent   = cfg.last_push_sent_at    ? new Date(cfg.last_push_sent_at).getTime()    : 0;
  const opened = cfg.last_chat_opened_at  ? new Date(cfg.last_chat_opened_at).getTime()  : 0;
  const replied= cfg.last_user_replied_at ? new Date(cfg.last_user_replied_at).getTime() : 0;

  if (!sent) return 'no_push_yet';
  if (replied > sent) return 'read_replied';
  if (opened > sent)  return 'read_no_reply';
  return 'unread';
}

// ─────────── 已读不回 × 标签 → 是否可发 ───────────
// 返回: { allow: true/false, reason: string }
function checkReadNoReply(bondLabel, slot, allowChaseOnRead) {
  const label = String(bondLabel || '朋友').trim();

  // 恋人/伴侣：允许 chase（可在设置里关闭）
  if (label === '恋人' || label === '伴侣') {
    if (allowChaseOnRead) return { allow: true, reason: 'chase_lover' };
    return { allow: false, reason: 'read_no_reply_chase_disabled' };
  }

  // 暧昧：允许 1 次 chase
  if (label === '暧昧') {
    if (allowChaseOnRead) return { allow: true, reason: 'chase_ambiguous' };
    return { allow: false, reason: 'read_no_reply_ambiguous_no_chase' };
  }

  // 朋友/家人：禁止 chase，但 nextDay 可以作为 fresh 新话题
  if (label === '朋友' || label === '家人' || label === '室友' || label === '邻居') {
    if (slot === 'nextDay') return { allow: true, reason: 'fresh_nextday' };
    return { allow: false, reason: 'read_no_reply_friend' };
  }

  // 同事/同学：完全不追发
  if (label === '同事' || label === '同学') {
    return { allow: false, reason: 'read_no_reply_colleague' };
  }

  // 前任：高好感才追发
  if (label === '前任') {
    if (allowChaseOnRead) return { allow: true, reason: 'chase_ex' };
    return { allow: false, reason: 'read_no_reply_ex' };
  }

  // 默认：不追发，nextDay 可 fresh
  if (slot === 'nextDay') return { allow: true, reason: 'fresh_nextday_default' };
  return { allow: false, reason: 'read_no_reply_default' };
}

// ─────────── 勿扰时段判断 ───────────
function isInQuietHours(nowDate, quietStart, quietEnd) {
  const startParts = String(quietStart || '23:30').split(':');
  const endParts   = String(quietEnd   || '08:00').split(':');
  const startMin = (parseInt(startParts[0]) || 23) * 60 + (parseInt(startParts[1]) || 30);
  const endMin   = (parseInt(endParts[0])   || 8)  * 60 + (parseInt(endParts[1])   || 0);

  const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();

  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // 跨午夜
  return nowMin >= startMin || nowMin < endMin;
}

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

async function sbPatchById(env, table, id, data) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: sbHeaders(env),
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`sbPatchById ${table} ${r.status}`);
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
    let pushBody;
    if (device.p256dh && device.auth) {
      pushBody = await encryptPayload(payload, device.p256dh, device.auth);
      headers['Content-Type']     = 'application/octet-stream';
      headers['Content-Encoding'] = 'aes128gcm';
    } else {
      headers['Content-Length'] = '0';
    }
    const resp = await fetch(device.endpoint, { method:'POST', headers, body: pushBody || undefined });
    if (resp.status === 410 || resp.status === 404) return { result:'expired', status:resp.status };
    if (resp.ok || resp.status === 201)             return { result:'ok',      status:resp.status };
    return { result:'fail', status:resp.status, text:(await resp.text()).slice(0,200) };
  } catch (err) {
    return { result:'fail', status:0, text:String(err.message || err) };
  }
}

// 语音通话推送：和普通推送用同样的加密逻辑，但 payload 不同
async function sendVoiceCallPush(device, npcName, npcId, env) {
  try {
    const url      = new URL(device.endpoint);
    const audience = url.protocol + '//' + url.host;
    const jwt      = await makeVapidJWT(env, audience);
    const payload  = JSON.stringify({
      type: 'voice_call',
      npcId, npcName,
      title: npcName,
      body: '📞 来电',
      ts: Date.now()
    });
    const headers = {
      Authorization: 'vapid t=' + jwt + ',k=' + env.VAPID_PUBLIC_KEY,
      TTL: '120', Urgency: 'high'
    };
    let pushBody;
    if (device.p256dh && device.auth) {
      pushBody = await encryptPayload(payload, device.p256dh, device.auth);
      headers['Content-Type']     = 'application/octet-stream';
      headers['Content-Encoding'] = 'aes128gcm';
    } else {
      headers['Content-Length'] = '0';
    }
    const resp = await fetch(device.endpoint, { method:'POST', headers, body: pushBody || undefined });
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

  const now = new Date();
  const nowIso = now.toISOString();
  const results = [];

  try {
    // ── 1. 过期扫描 ──
    try {
      const expireUrl =
        `${env.SUPABASE_URL}/rest/v1/meow_scheduled_push` +
        `?state=eq.planned` +
        `&expires_at=lt.${encodeURIComponent(nowIso)}`;

      await fetch(expireUrl, {
        method: 'PATCH',
        headers: sbHeaders(env),
        body: JSON.stringify({
          state:         'expired',
          cancel_reason: 'auto_expired',
          is_cancelled:  true,
          cancelled_at:  nowIso,
          updated_at:    nowIso
        })
      });
    } catch(e) {
      console.error('[proactive] expire sweep error:', e);
    }

    // ── 2. 查找到时间的 planned 消息 ──
    const pending = await sbSelect(env, 'meow_scheduled_push',
      `&state=eq.planned&push_at=lte.${encodeURIComponent(nowIso)}&order=push_at.asc&limit=20`
    );

    if (!pending || !pending.length) {
      return jsonResp({ ok: true, msg: '无待发消息', total: 0 });
    }

    // ── 3. 加载全局推送设置（勿扰时段） ──
    let globalSettings = null;
    try {
      const settingsArr = await sbSelect(env, 'meow_push_settings', `&limit=1`);
      globalSettings = (settingsArr && settingsArr[0]) || null;
    } catch(e) {}

    const quietStart = (globalSettings && globalSettings.quiet_hours_start) || '23:30';
    const quietEnd   = (globalSettings && globalSettings.quiet_hours_end)   || '08:00';

    // 勿扰时段检查（全局，所有消息一起跳过）
    if (isInQuietHours(now, quietStart, quietEnd)) {
      // 全部标记为 skipped
      for (const msg of pending) {
        await sbPatchById(env, 'meow_scheduled_push', msg.id, {
          state: 'skipped', skip_reason: 'quiet_hours', updated_at: nowIso
        });
        results.push({ id: msg.id, npc_id: msg.npc_id, state: 'skipped', skip_reason: 'quiet_hours' });
      }
      return jsonResp({ ok: true, total: results.length, results, note: 'quiet_hours' });
    }

    // ── 4. 缓存：按 uid+npc_id 加载 NPC 配置 + 本轮已发计数 ──
    const configCache = {};
    const sentCountCache = {};

    async function getNpcConfig(uid, npcId) {
      const key = uid + '::' + npcId;
      if (configCache[key] !== undefined) return configCache[key];
      try {
        const arr = await sbSelect(env, 'meow_npc_push_config',
          `&uid=eq.${encodeURIComponent(uid)}&npc_id=eq.${encodeURIComponent(npcId)}&limit=1`
        );
        configCache[key] = (arr && arr[0]) || null;
      } catch(e) {
        configCache[key] = null;
      }
      return configCache[key];
    }

    // 计算本轮已发数：同 batch_id 下已发（sent/opened/replied）的条数
    async function getSentCount(uid, npcId, batchId) {
      const key = uid + '::' + npcId + '::' + (batchId || 'any');
      if (sentCountCache[key] !== undefined) return sentCountCache[key];
      try {
        let filter = `&uid=eq.${encodeURIComponent(uid)}&npc_id=eq.${encodeURIComponent(npcId)}` +
          `&state=in.(sent,opened,replied)`;
        if (batchId) filter += `&source_batch_id=eq.${encodeURIComponent(batchId)}`;
        const arr = await sbSelect(env, 'meow_scheduled_push', filter);
        sentCountCache[key] = (arr || []).length;
      } catch(e) {
        sentCountCache[key] = 0;
      }
      return sentCountCache[key];
    }

    // ── 5. 逐条判断 + 发送 ──
    for (const msg of pending) {
      const { id, uid, npc_id, npc_name, text, slot, batch_id, source_batch_id } = msg;
      const effectiveBatchId = source_batch_id || batch_id;

      // 加载该 NPC 的配置
      const cfg = await getNpcConfig(uid, npc_id);
      const bondLabel       = (cfg && (cfg.bond_label || cfg.bond)) || '朋友';
      const affinity        = (cfg && typeof cfg.affinity === 'number') ? cfg.affinity : 30;
      const allowChaseOnRead= (cfg && cfg.allow_chase_on_read) || false;

      // ── 检查 A: 好感度太低不发 ──
      const maxPushes = getMaxPushes(affinity);
      if (maxPushes <= 0) {
        await sbPatchById(env, 'meow_scheduled_push', id, {
          state: 'skipped', skip_reason: 'affinity_too_low', updated_at: nowIso
        });
        results.push({ id, npc_id, state: 'skipped', skip_reason: 'affinity_too_low', affinity });
        continue;
      }

      // ── 检查 B: 本轮已发数超上限 ──
      const sentCount = await getSentCount(uid, npc_id, effectiveBatchId);
      if (sentCount >= maxPushes) {
        await sbPatchById(env, 'meow_scheduled_push', id, {
          state: 'skipped', skip_reason: 'over_limit', updated_at: nowIso
        });
        results.push({ id, npc_id, state: 'skipped', skip_reason: 'over_limit', sentCount, maxPushes });
        continue;
      }

      // ── 检查 C: 会话状态 × 标签 ──
      const sessionState = cfg ? deriveSessionState(cfg) : 'no_push_yet';
      let skipBySession = null;

      if (sessionState === 'read_no_reply') {
        const check = checkReadNoReply(bondLabel, slot, allowChaseOnRead);
        if (!check.allow) {
          skipBySession = check.reason;
        }
      }
      // 'unread' 和 'no_push_yet' 和 'read_replied' 都允许发送

      if (skipBySession) {
        await sbPatchById(env, 'meow_scheduled_push', id, {
          state: 'skipped', skip_reason: skipBySession, behavior_type: 'blocked_by_session', updated_at: nowIso
        });
        results.push({ id, npc_id, state: 'skipped', skip_reason: skipBySession, sessionState, bondLabel });
        continue;
      }

      // ── 所有检查通过 → 发送 ──
      const devices = await sbSelect(env, 'meow_devices', `&uid=eq.${encodeURIComponent(uid)}`);
      let pushed = 0;

      // voice_call slot 用特殊 payload
      const isVoiceCall = (slot === 'voice_call');

      for (const dev of (devices || [])) {
        let res;
        if (isVoiceCall) {
          res = await sendVoiceCallPush(dev, npc_name, npc_id, env);
        } else {
          res = await sendWebPush(dev, npc_name, npc_id, text, env);
        }
        if (res.result === 'expired') {
          await sbDelete(env, 'meow_devices', { endpoint: dev.endpoint });
        } else if (res.result === 'ok') {
          pushed++;
        }
      }

      if (pushed > 0) {
        // 确定 behavior_type
        let behaviorType = 'normal';
        if (sessionState === 'unread') behaviorType = 'chase_unread';
        if (sessionState === 'read_no_reply') behaviorType = 'chase_read';

        await sbPatchById(env, 'meow_scheduled_push', id, {
          state:         'sent',
          behavior_type: behaviorType,
          is_sent:       true,
          sent_at:       nowIso,
          updated_at:    nowIso
        });

        // 更新会话状态
        try {
          const sessionUrl =
            `${env.SUPABASE_URL}/rest/v1/meow_npc_push_config` +
            `?uid=eq.${encodeURIComponent(uid)}` +
            `&npc_id=eq.${encodeURIComponent(npc_id)}`;

          await fetch(sessionUrl, {
            method: 'PATCH',
            headers: sbHeaders(env),
            body: JSON.stringify({ last_push_sent_at: nowIso, updated_at: nowIso })
          });
        } catch(e) {
          console.warn('[proactive] update last_push_sent_at failed:', e);
        }

        // 使 sentCount 缓存失效
        const cacheKey = uid + '::' + npc_id + '::' + (effectiveBatchId || 'any');
        sentCountCache[cacheKey] = (sentCountCache[cacheKey] || 0) + 1;

        // ★ Step8: 语音通话追加
        // 条件：已读不回 + 恋人/伴侣 + 好感60+ + 全局开启 + 近24h有互动
        if (behaviorType === 'chase_read' &&
            (bondLabel === '恋人' || bondLabel === '伴侣') &&
            affinity >= 60 &&
            globalSettings && globalSettings.enable_voice_chase !== false) {

          // 检查近24小时是否有互动（防止对僵尸号打电话）
          const lastReplied = cfg && cfg.last_user_replied_at ? new Date(cfg.last_user_replied_at).getTime() : 0;
          const recentInteraction = (Date.now() - lastReplied) < 24 * 60 * 60 * 1000;

          if (recentInteraction) {
            // 延迟 3~8 分钟后发语音通话推送
            try {
              const callDelay = (3 + Math.floor(Math.random() * 6)) * 60 * 1000;
              const callAt = new Date(Date.now() + callDelay).toISOString();

              await sbInsert(env, 'meow_scheduled_push', {
                uid,
                npc_id,
                npc_name,
                text: JSON.stringify({ type: 'voice_call', npcId: npc_id, npcName: npc_name }),
                push_at: callAt,
                slot: 'voice_call',
                state: 'planned',
                expires_at: new Date(Date.now() + callDelay + 2 * 60 * 60 * 1000).toISOString(),
                source_batch_id: effectiveBatchId,
                channel: 'backend-push',
                behavior_type: 'voice_call_chase',
                is_sent: false,
                is_cancelled: false,
                created_at: nowIso,
                updated_at: nowIso
              });
              console.log('[proactive] 语音通话追加已安排:', npc_name, callAt);
            } catch(e) {
              console.warn('[proactive] voice call schedule failed:', e);
            }
          }
        }
      } else {
        await sbPatchById(env, 'meow_scheduled_push', id, {
          state: 'skipped', skip_reason: 'no_valid_device', updated_at: nowIso
        });
      }

      // 存到 pending_messages 供前端拉取
      if (pushed > 0) {
        try {
          await sbInsert(env, 'meow_pending_messages', {
            uid, npc_id, npc_name, text, kind: 'bgpush', ts: Date.now(), is_pulled: false
          });
        } catch(e) {}
      }

      results.push({
        id, npc_id, npc_name, pushed, slot: slot || null,
        state: pushed > 0 ? 'sent' : 'skipped',
        skip_reason: pushed > 0 ? null : 'no_valid_device',
        sessionState, bondLabel, affinity,
        behavior_type: pushed > 0 ? (sessionState === 'unread' ? 'chase_unread' : 'normal') : null,
        batch_id: effectiveBatchId || null,
        preview: text.slice(0, 30)
      });
    }

    // ── 6. 清理 7 天前终态记录 ──
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const cleanUrl =
        `${env.SUPABASE_URL}/rest/v1/meow_scheduled_push` +
        `?created_at=lt.${encodeURIComponent(cutoff)}` +
        `&state=in.(sent,expired,cancelled,skipped,opened,replied)`;
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
