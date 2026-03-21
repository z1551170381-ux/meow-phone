// netlify/functions/pull.js
// 前端打开页面 / 切回前台时调用，拉取后端生成的离线消息
// GET /.netlify/functions/pull?uid=xxx

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const uid = event.queryStringParameters?.uid || '';
  if (!uid) {
    return { statusCode: 400, body: 'Missing uid' };
  }

  try {
    // 拉取该用户未读的离线消息
    const { data: msgs, error } = await supabase
      .from('meow_pending_messages')
      .select('*')
      .eq('uid', uid)
      .eq('is_pulled', false)
      .order('ts', { ascending: true });

    if (error) throw error;

    if (!msgs || msgs.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, messages: [] })
      };
    }

    // 标记为已拉取
    const ids = msgs.map(m => m.id);
    await supabase
      .from('meow_pending_messages')
      .update({ is_pulled: true })
      .in('id', ids);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        messages: msgs.map(m => ({
          npcId:   m.npc_id,
          npcName: m.npc_name,
          text:    m.text,
          kind:    m.kind,
          ts:      m.ts
        }))
      })
    };

  } catch(err) {
    console.error('[pull] error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(err.message || err) })
    };
  }
};
