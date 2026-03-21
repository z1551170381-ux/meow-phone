// functions/api/pull.js
// Cloudflare Pages 版：返回消息但不全局消费，避免多设备互抢
// 支持：/api/pull?uid=standalone_main&since=时间戳&limit=50

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const uid = String(url.searchParams.get('uid') || '').trim();
  const since = Number(url.searchParams.get('since') || 0);
  const limitRaw = Number(url.searchParams.get('limit') || 50);
  const limit = Math.min(Math.max(limitRaw || 50, 1), 200);

  if (!uid) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Missing uid'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;

  if (!base || !key) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`
  };

  try {
    // 没传 since 时，只拉最近 48 小时，避免历史全量反复灌回来
    const fallbackSince = Date.now() - 48 * 60 * 60 * 1000;
    const minTs = since > 0 ? since : fallbackSince;

    const selectUrl =
      `${base}/rest/v1/meow_pending_messages` +
      `?select=id,uid,npc_id,npc_name,text,kind,ts` +
      `&uid=eq.${encodeURIComponent(uid)}` +
      `&ts=gt.${minTs}` +
      `&order=ts.asc` +
      `&limit=${limit}`;

    const resp = await fetch(selectUrl, { headers });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`select error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const msgs = await resp.json();

    return new Response(JSON.stringify({
      ok: true,
      messages: (msgs || []).map(m => ({
        id: m.id,
        npcId: m.npc_id,
        npcName: m.npc_name,
        text: m.text,
        kind: m.kind,
        ts: Number(m.ts || 0)
      }))
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('[pull] error:', err);
    return new Response(JSON.stringify({
      ok: false,
      error: String(err.message || err)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
