// functions/api/pull.js
// 完全无依赖版 - 直接用 fetch 调 Supabase REST API

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const uid = url.searchParams.get('uid') || '';

  if (!uid) return new Response('Missing uid', { status: 400 });

  const base = env.SUPABASE_URL;
  const key  = env.SUPABASE_SERVICE_KEY;
  const headers = { 'apikey': key, 'Authorization': `Bearer ${key}` };

  try {
    // 查未读消息
    const selectUrl = `${base}/rest/v1/meow_pending_messages?select=*&uid=eq.${encodeURIComponent(uid)}&is_pulled=eq.false&order=ts.asc`;
    const resp = await fetch(selectUrl, { headers });
    if (!resp.ok) throw new Error(`select error ${resp.status}`);
    const msgs = await resp.json();

    if (!msgs || msgs.length === 0) {
      return new Response(JSON.stringify({ ok:true, messages:[] }), {
        headers: { 'Content-Type':'application/json' }
      });
    }

    // 标记已读
    const ids = msgs.map(m => m.id);
    const updateUrl = `${base}/rest/v1/meow_pending_messages?id=in.(${ids.join(',')})`;
    await fetch(updateUrl, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type':'application/json', 'Prefer':'return=minimal' },
      body: JSON.stringify({ is_pulled: true })
    });

    return new Response(JSON.stringify({
      ok: true,
      messages: msgs.map(m => ({
        npcId:   m.npc_id,
        npcName: m.npc_name,
        text:    m.text,
        kind:    m.kind,
        ts:      m.ts
      }))
    }), { headers: { 'Content-Type':'application/json' } });

  } catch(err) {
    console.error('[pull] error:', err);
    return new Response(JSON.stringify({ ok:false, error:String(err.message||err) }), {
      status:500, headers:{'Content-Type':'application/json'}
    });
  }
}
