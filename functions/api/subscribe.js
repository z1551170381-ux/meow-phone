// functions/api/subscribe.js
// 兼容增强版：设备订阅 + 用户 API 配置 + NPC 主动推送上下文上报
// 说明：
// 1) 优先把 summary / world_context / recent_memory / npc_state / user_state / current_scene / location / user_profile 等字段一起写入 meow_npc_push_config
// 2) 如果 Supabase 表还没加这些列，不会导致整个接口失败，会自动降级为旧版基础字段写入
// 3) 返回 warnings，方便你前端或日志里看出是不是“表缺列导致没吃到上下文”

function toStr(v, max = 1000) {
  return String(v == null ? '' : v)
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);
}

function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function safeJsonStringify(v, max = 1500) {
  try {
    if (typeof v === 'string') return toStr(v, max);
    return toStr(JSON.stringify(v || ''), max);
  } catch (e) {
    return '';
  }
}

function compactText(v, max = 1000) {
  return toStr(v, max)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function pickFirst(obj, keys, max = 1000) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    if (obj[key] != null && String(obj[key]).trim()) {
      return compactText(obj[key], max);
    }
  }
  return '';
}

function normalizeNpcRow(uid, npc) {
  const id = toStr(npc?.id || npc?.npc_id || npc?.npcId, 120);
  const name = toStr(npc?.name || npc?.npc_name || npc?.npcName || id, 120);

  const profile = compactText(
    npc?.profile ||
    npc?.npc_profile ||
    npc?.persona ||
    npc?.characterPrompt ||
    '',
    1200
  );

  const onlineChatPrompt = compactText(
    npc?.onlineChatPrompt ||
    npc?.online_chat_prompt ||
    npc?.chatPrompt ||
    '',
    1200
  );

  const bond = toStr(
    npc?.bond ||
    npc?.relation ||
    npc?.relationship ||
    '普通',
    40
  ) || '普通';

  const summary = compactText(
    pickFirst(npc, [
      'summary',
      'recent_summary',
      'chat_summary',
      'summary_text',
      'timeline_summary'
    ], 1600),
    1600
  );

  const worldContext = compactText(
    pickFirst(npc, [
      'world_context',
      'worldbook',
      'world_book',
      'worldbook_text',
      'world_summary'
    ], 1600),
    1600
  );

  const recentMemory = compactText(
    pickFirst(npc, [
      'recent_memory',
      'memory',
      'recent_event',
      'last_topic'
    ], 1000),
    1000
  );

  const npcState = compactText(
    pickFirst(npc, [
      'npc_state',
      'current_state',
      'status',
      'doing',
      'mood_state',
      'moodText',
      'currentBehavior'
    ], 500),
    500
  );

  const userState = compactText(
    pickFirst(npc, [
      'user_state',
      'player_state',
      'persona_state'
    ], 500),
    500
  );

  const currentScene = compactText(
    pickFirst(npc, [
      'current_scene',
      'scene',
      'scene_name',
      'recent_scene'
    ], 300),
    300
  );

  const location = compactText(
    pickFirst(npc, [
      'location',
      'current_location',
      'place',
      'landmark'
    ], 200),
    200
  );

  const userProfile = compactText(
    pickFirst(npc, [
      'user_profile',
      'persona_profile',
      'player_profile'
    ], 1000),
    1000
  );

  const relationshipNote = compactText(
    pickFirst(npc, [
      'relationship_note',
      'bond_note',
      'relation_summary'
    ], 600),
    600
  );

  const metadata = safeJsonStringify({
    source: 'subscribe',
    rawKeys: npc ? Object.keys(npc).slice(0, 80) : [],
    syncAt: new Date().toISOString()
  }, 1200);

  const baseRow = {
    uid,
    npc_id: id,
    npc_name: name,
    npc_profile: profile.slice(0, 1200),
    enable_push: toBool(npc?.enableLifePush ?? npc?.enable_push, true),
    bond,
    online_chat_prompt: onlineChatPrompt.slice(0, 1200),
    updated_at: new Date().toISOString()
  };

  const extendedRow = {
    ...baseRow,
    summary,
    world_context: worldContext,
    recent_memory: recentMemory,
    npc_state: npcState,
    user_state: userState,
    current_scene: currentScene,
    location,
    user_profile: userProfile,
    relationship_note: relationshipNote,
    meta_json: metadata
  };

  return { id, baseRow, extendedRow };
}

async function supabaseUpsert(env, table, data, onConflict, prefer = 'resolution=merge-duplicates') {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Prefer: prefer
    },
    body: JSON.stringify(data)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase ${table} error: ${err.slice(0, 500)}`);
  }

  return resp;
}

async function upsertNpcConfigWithFallback(env, rowBase, rowExtended, warnings, npcId) {
  try {
    await supabaseUpsert(env, 'meow_npc_push_config', rowExtended, 'uid,npc_id');
    return { ok: true, mode: 'extended' };
  } catch (err) {
    const msg = String(err?.message || err || '');
    const maybeMissingColumn =
      /column .* does not exist/i.test(msg) ||
      /Could not find the .* column/i.test(msg) ||
      /schema cache/i.test(msg) ||
      /invalid input/i.test(msg);

    if (!maybeMissingColumn) {
      throw err;
    }

    warnings.push({
      npcId,
      type: 'missing-columns-fallback',
      message: 'meow_npc_push_config 缺少上下文字段列，已自动降级为基础字段写入',
      detail: msg.slice(0, 300)
    });

    await supabaseUpsert(env, 'meow_npc_push_config', rowBase, 'uid,npc_id');
    return { ok: true, mode: 'base-fallback' };
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Invalid JSON'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const {
    uid,
    subscription,
    npcs,
    apiConfig,
    enableBackgroundPush
  } = body || {};

  if (!uid || !subscription || !subscription.endpoint) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Missing uid or subscription'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const keys = subscription.keys || {};
  const warnings = [];
  const savedNpcResults = [];

  try {
    // 1. 存设备订阅
    await supabaseUpsert(env, 'meow_devices', {
      uid: toStr(uid, 120),
      endpoint: toStr(subscription.endpoint, 2000),
      p256dh: toStr(keys.p256dh || '', 500),
      auth: toStr(keys.auth || '', 500),
      updated_at: new Date().toISOString()
    }, 'endpoint');

    // 2. 仅在用户明确开启后台推送且提供了 API 配置时写入
    if (toBool(enableBackgroundPush, false) && apiConfig && apiConfig.apiKey && apiConfig.baseUrl) {
      await supabaseUpsert(env, 'meow_user_api_config', {
        uid: toStr(uid, 120),
        base_url: toStr(apiConfig.baseUrl || '', 1000),
        api_key: toStr(apiConfig.apiKey || '', 2000),
        model: toStr(apiConfig.model || '', 200),
        updated_at: new Date().toISOString()
      }, 'uid');
    }

    // 3. 存角色配置（增强版：优先上报上下文）
    if (Array.isArray(npcs) && npcs.length > 0) {
      for (const npc of npcs) {
        const { id, baseRow, extendedRow } = normalizeNpcRow(toStr(uid, 120), npc);
        if (!id) continue;

        const saveRes = await upsertNpcConfigWithFallback(
          env,
          baseRow,
          extendedRow,
          warnings,
          id
        );

        savedNpcResults.push({
          npc_id: id,
          mode: saveRes.mode,
          has_summary: !!extendedRow.summary,
          has_world_context: !!extendedRow.world_context,
          has_recent_memory: !!extendedRow.recent_memory,
          has_npc_state: !!extendedRow.npc_state,
          has_user_state: !!extendedRow.user_state,
          has_current_scene: !!extendedRow.current_scene,
          has_location: !!extendedRow.location,
          has_user_profile: !!extendedRow.user_profile
        });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      warnings,
      savedNpcResults
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[subscribe] error:', err);
    return new Response(JSON.stringify({
      ok: false,
      error: String(err.message || err),
      warnings
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}