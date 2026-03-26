// functions/api/affinity.js — v2.1 Step 5
// AI 提交 reason + intensity，后端查规则表算 delta
// POST { uid, npcId, reason, intensity }
// 返回 { ok, affinity, delta, reason }

// ─────────── 规则表 ───────────
// reason → { low, medium, high } 的 delta 值
const RULES = {
  normal_chat:  { low: 1,   medium: 2,   high: 3   },
  comfort:      { low: 2,   medium: 4,   high: 7   },
  trust:        { low: 3,   medium: 6,   high: 10  },
  milestone:    { low: 8,   medium: 14,  high: 20  },
  conflict:     { low: -5,  medium: -12, high: -25 },
  reconcile:    { low: 3,   medium: 8,   high: 15  },
  betrayal:     { low: -15, medium: -30, high: -50 },
  neglect:      { low: -1,  medium: -2,  high: -3  },
  flirt:        { low: 2,   medium: 5,   high: 8   },
  jealousy:     { low: -2,  medium: -5,  high: -10 },
  gift:         { low: 2,   medium: 4,   high: 8   },
  support:      { low: 2,   medium: 5,   high: 10  },
  humor:        { low: 1,   medium: 3,   high: 5   },
  rejection:    { low: -3,  medium: -8,  high: -15 },
  ignore:       { low: -1,  medium: -3,  high: -5  },
};

// 最大单次变化幅度
const MAX_POSITIVE_DELTA = 20;
const MAX_NEGATIVE_DELTA = -50;
const AFFINITY_MIN = -100;
const AFFINITY_MAX = 100;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    let body;
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('json')) {
      body = await request.json();
    } else {
      const raw = await request.text();
      body = JSON.parse(raw);
    }

    const uid       = String(body.uid       || '').trim();
    const npcId     = String(body.npcId     || body.npc_id || '').trim();
    const reason    = String(body.reason    || '').trim().toLowerCase();
    const intensity = String(body.intensity || 'medium').trim().toLowerCase();

    if (!uid || !npcId) {
      return jsonResp({ ok: false, error: 'missing uid or npcId' }, 400);
    }

    if (!reason) {
      return jsonResp({ ok: false, error: 'missing reason' }, 400);
    }

    // 查规则表
    const rule = RULES[reason];
    if (!rule) {
      return jsonResp({ ok: false, error: 'unknown reason: ' + reason, validReasons: Object.keys(RULES) }, 400);
    }

    const validIntensity = ['low', 'medium', 'high'].includes(intensity) ? intensity : 'medium';
    let delta = rule[validIntensity] || rule.medium;

    // clamp delta
    delta = Math.max(MAX_NEGATIVE_DELTA, Math.min(MAX_POSITIVE_DELTA, delta));

    const base = env.SUPABASE_URL;
    const key  = env.SUPABASE_SERVICE_KEY;
    if (!base || !key) {
      return jsonResp({ ok: false, error: 'missing env config' }, 500);
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`
    };

    // 读取当前 affinity
    const selectUrl =
      `${base}/rest/v1/meow_npc_push_config` +
      `?select=affinity` +
      `&uid=eq.${encodeURIComponent(uid)}` +
      `&npc_id=eq.${encodeURIComponent(npcId)}` +
      `&limit=1`;

    const selectResp = await fetch(selectUrl, { headers });
    let currentAffinity = 20; // 默认

    if (selectResp.ok) {
      const arr = await selectResp.json();
      if (arr && arr[0] && typeof arr[0].affinity === 'number') {
        currentAffinity = arr[0].affinity;
      }
    }

    // 计算新值
    let newAffinity = currentAffinity + delta;
    newAffinity = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, newAffinity));

    // 写入
    const updateUrl =
      `${base}/rest/v1/meow_npc_push_config` +
      `?uid=eq.${encodeURIComponent(uid)}` +
      `&npc_id=eq.${encodeURIComponent(npcId)}`;

    const updateResp = await fetch(updateUrl, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        affinity: newAffinity,
        updated_at: new Date().toISOString()
      })
    });

    // 如果行不存在，upsert
    if (!updateResp.ok) {
      const upsertUrl = `${base}/rest/v1/meow_npc_push_config?on_conflict=uid,npc_id`;
      await fetch(upsertUrl, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          uid,
          npc_id: npcId,
          affinity: newAffinity,
          updated_at: new Date().toISOString()
        })
      });
    }

    return jsonResp({
      ok: true,
      uid,
      npcId,
      reason,
      intensity: validIntensity,
      delta,
      previousAffinity: currentAffinity,
      affinity: newAffinity
    });

  } catch (err) {
    console.error('[affinity] error:', err);
    return jsonResp({ ok: false, error: String(err.message || err) }, 500);
  }
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
