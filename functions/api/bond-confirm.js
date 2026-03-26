// functions/api/bond-confirm.js — v2.1 Step 7
// 标签切换确认接口
// AI 识别到关系质变时写入 pending_bond_label
// 玩家在对话中接受/拒绝后调用此接口
//
// POST { uid, npcId, accept: true }  → pending_bond_label 落地到 bond_label
// POST { uid, npcId, accept: false } → 清空 pending_bond_label
// POST { uid, npcId, suggest: "恋人" } → AI 写入 pending_bond_label（供前端调用）

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

    const uid   = String(body.uid   || '').trim();
    const npcId = String(body.npcId || body.npc_id || '').trim();

    if (!uid || !npcId) {
      return jsonResp({ ok: false, error: 'missing uid or npcId' }, 400);
    }

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

    const now = new Date().toISOString();
    const VALID_LABELS = ['朋友', '家人', '暧昧', '恋人', '伴侣', '同事', '同学', '前任', '室友'];

    // ── 模式1：AI 建议切换（写入 pending） ──
    if (body.suggest) {
      const suggest = String(body.suggest).trim();
      if (!VALID_LABELS.includes(suggest)) {
        return jsonResp({ ok: false, error: 'invalid label: ' + suggest, validLabels: VALID_LABELS }, 400);
      }

      const updateUrl =
        `${base}/rest/v1/meow_npc_push_config` +
        `?uid=eq.${encodeURIComponent(uid)}` +
        `&npc_id=eq.${encodeURIComponent(npcId)}`;

      const resp = await fetch(updateUrl, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          pending_bond_label: suggest,
          updated_at: now
        })
      });

      // 行不存在则 upsert
      if (!resp.ok) {
        await fetch(`${base}/rest/v1/meow_npc_push_config?on_conflict=uid,npc_id`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            uid, npc_id: npcId,
            pending_bond_label: suggest,
            updated_at: now
          })
        });
      }

      return jsonResp({ ok: true, action: 'suggested', pendingLabel: suggest });
    }

    // ── 模式2：玩家确认/拒绝 ──
    const accept = !!body.accept;

    // 先读取当前 pending_bond_label
    const selectUrl =
      `${base}/rest/v1/meow_npc_push_config` +
      `?select=bond_label,pending_bond_label,affinity` +
      `&uid=eq.${encodeURIComponent(uid)}` +
      `&npc_id=eq.${encodeURIComponent(npcId)}` +
      `&limit=1`;

    const selectResp = await fetch(selectUrl, { headers });
    if (!selectResp.ok) {
      return jsonResp({ ok: false, error: 'failed to read config' }, 500);
    }

    const arr = await selectResp.json();
    const cfg = (arr && arr[0]) || null;

    if (!cfg || !cfg.pending_bond_label) {
      return jsonResp({ ok: false, error: 'no pending label to confirm' }, 400);
    }

    const pendingLabel = cfg.pending_bond_label;
    const oldLabel = cfg.bond_label || '朋友';
    const currentAffinity = typeof cfg.affinity === 'number' ? cfg.affinity : 20;

    if (accept) {
      // 接受：pending 落地到 bond_label，清空 pending
      // 同时根据新标签调整好感度初始值（如果当前好感低于新标签的下限）
      const labelDefaults = {
        '朋友': 20, '家人': 40, '暧昧': 30, '恋人': 60,
        '伴侣': 75, '同事': 10, '同学': 10, '前任': 15, '室友': 15
      };
      const minAffinity = labelDefaults[pendingLabel] || 20;
      const newAffinity = Math.max(currentAffinity, minAffinity);

      // 暧昧/恋人/伴侣 自动开启 allow_chase_on_read
      const autoChase = ['暧昧', '恋人', '伴侣'].includes(pendingLabel);

      const updateUrl =
        `${base}/rest/v1/meow_npc_push_config` +
        `?uid=eq.${encodeURIComponent(uid)}` +
        `&npc_id=eq.${encodeURIComponent(npcId)}`;

      await fetch(updateUrl, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          bond_label: pendingLabel,
          pending_bond_label: null,
          affinity: newAffinity,
          allow_chase_on_read: autoChase,
          updated_at: now
        })
      });

      return jsonResp({
        ok: true,
        action: 'accepted',
        oldLabel,
        newLabel: pendingLabel,
        affinity: newAffinity,
        allowChaseOnRead: autoChase
      });

    } else {
      // 拒绝：清空 pending，可能降一点好感（被拒绝了嘛）
      const updateUrl =
        `${base}/rest/v1/meow_npc_push_config` +
        `?uid=eq.${encodeURIComponent(uid)}` +
        `&npc_id=eq.${encodeURIComponent(npcId)}`;

      await fetch(updateUrl, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          pending_bond_label: null,
          affinity: Math.max(-100, currentAffinity - 5),
          updated_at: now
        })
      });

      return jsonResp({
        ok: true,
        action: 'rejected',
        oldLabel,
        rejectedLabel: pendingLabel,
        affinity: Math.max(-100, currentAffinity - 5)
      });
    }

  } catch (err) {
    console.error('[bond-confirm] error:', err);
    return jsonResp({ ok: false, error: String(err.message || err) }, 500);
  }
}

function jsonResp(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
