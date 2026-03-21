// api/pull.js
// Vercel 版：返回消息但不全局消费，避免多设备互抢
// 支持：/api/pull?uid=standalone_main&since=时间戳

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const uid = String(req.query.uid || '').trim();
  const since = Number(req.query.since || 0);
  const limitRaw = Number(req.query.limit || 50);
  const limit = Math.min(Math.max(limitRaw || 50, 1), 200);

  if (!uid) {
    return res.status(400).json({ ok: false, error: 'Missing uid' });
  }

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!base || !key) {
    return res.status(500).json({
      ok: false,
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'
    });
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`
  };

  try {
    // 没传 since 时，只拉最近 48 小时，避免无限灌历史
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

    return res.status(200).json({
      ok: true,
      messages: (msgs || []).map(m => ({
        id: m.id,
        npcId: m.npc_id,
        npcName: m.npc_name,
        text: m.text,
        kind: m.kind,
        ts: Number(m.ts || 0)
      }))
    });
  } catch (err) {
    console.error('[pull] error:', err);
    return res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
}