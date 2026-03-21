// functions/api/pull.js
// Cloudflare Pages Functions 版本
// GET /api/pull?uid=xxx

import { createClient } from '@supabase/supabase-js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const uid = url.searchParams.get('uid') || '';

  if (!uid) {
    return new Response('Missing uid', { status: 400 });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  try {
    const { data: msgs, error } = await supabase
      .from('meow_pending_messages')
      .select('*')
      .eq('uid', uid)
      .eq('is_pulled', false)
      .order('ts', { ascending: true });

    if (error) throw error;

    if (!msgs || msgs.length === 0) {
      return new Response(JSON.stringify({ ok: true, messages: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 标记已拉取
    const ids = msgs.map(m => m.id);
    await supabase
      .from('meow_pending_messages')
      .update({ is_pulled: true })
      .in('id', ids);

    return new Response(JSON.stringify({
      ok: true,
      messages: msgs.map(m => ({
        npcId:   m.npc_id,
        npcName: m.npc_name,
        text:    m.text,
        kind:    m.kind,
        ts:      m.ts
      }))
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch(err) {
    console.error('[pull] error:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
