// ====== sw.js — 喵喵推送 v3 Service Worker ======
// 核心能力：
//   1. 收到后端推送（payload 只有 npcId + kind + fallbackTexts）
//   2. 从 IndexedDB 读取 API 配置 + 角色快照
//   3. 直接在 SW 内 fetch 调模型 API 生成多条消息
//   4. 依次 showNotification 模拟真人连发
//   5. 把消息存入 IDB 供前端读取
//   6. 尝试 postMessage 通知前端注入聊天记录

const DB_NAME = 'meow_phone_db';
const DB_VERSION = 1;
const KV_STORE = 'kv';


// ══════════════════════════════════════════════════════════════
//  IDB 工具（SW 里不能用前端的 MeowDB，需要独立实现）
// ══════════════════════════════════════════════════════════════

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      ['kv','feedPacks','chatLogs','summaries','media','forumChats'].forEach(name => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readonly');
    const req = tx.objectStore(KV_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite');
    const req = tx.objectStore(KV_STORE).put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}


// ══════════════════════════════════════════════════════════════
//  缓存（基本的 app shell 缓存）
// ══════════════════════════════════════════════════════════════

const CACHE_NAME = 'meow-phone-v3';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});


// ══════════════════════════════════════════════════════════════
//  ★ Push Event — 核心逻辑
// ══════════════════════════════════════════════════════════════

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  // ── 1. 解析 payload ──
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    try { payload = { text: event.data.text() }; } catch (e2) {}
  }

  const npcId = payload.npcId || '';
  const kind = payload.kind || 'daily';
  const fallbackTexts = payload.fallbackTexts || ['在吗', '有空吗'];
  const npcName = payload.npcName || '消息';

  if (!npcId) {
    // 无角色 ID，直接用 payload 里的 text 兜底
    await self.registration.showNotification(npcName, {
      body: payload.text || '你收到了一条新消息',
      icon: '/icon-192.png',
      data: { action: 'open-app' }
    });
    return;
  }

  // ── 2. 尝试从 IDB 读取 API 配置 + 角色快照 ──
  let apiConfig = null;
  let snapshot = null;
  let globalCtx = null;

  try {
    apiConfig = await idbGet('meow_sw_api_config');
    snapshot = await idbGet('meow_sw_snapshot_' + npcId);
    globalCtx = await idbGet('meow_sw_global_context');
  } catch (e) {
    console.warn('[SW] IDB 读取失败:', e);
  }

  // ── 3. 检查快照新鲜度（超过 10 分钟视为过期，降低权重但仍使用）──
  let snapshotStale = false;
  if (snapshot && snapshot.updatedAt) {
    snapshotStale = (Date.now() - snapshot.updatedAt) > 10 * 60 * 1000;
  }

  // ── 4. 尝试调 API 生成多条消息 ──
  let messages = null;

  if (apiConfig && apiConfig.apiKey && apiConfig.baseUrl && snapshot) {
    try {
      messages = await generateMessages(apiConfig, snapshot, globalCtx, kind, snapshotStale);
    } catch (e) {
      console.warn('[SW] API 调用失败，使用兜底:', e);
    }
  }

  // ── 5. API 失败时检查预生成缓存 ──
  if (!messages || !messages.length) {
    try {
      const cached = await idbGet('meow_sw_prefetch_' + npcId);
      if (cached && cached.messages && cached.messages.length) {
        messages = cached.messages;
        // 用完就删
        await idbPut('meow_sw_prefetch_' + npcId, null);
        console.log('[SW] 使用预生成缓存:', messages.length, '条');
      }
    } catch (e) {}
  }

  // ── 6. 都没有，用兜底短句 ──
  if (!messages || !messages.length) {
    messages = fallbackTexts;
  }

  // ── 7. 存入 IDB 供前端读取（iOS 可能无法 postMessage）──
  try {
    await idbPut('meow_sw_pending_msgs_' + npcId, {
      npcId: npcId,
      messages: messages,
      generatedAt: Date.now(),
      kind: kind
    });
  } catch (e) {}

  // ── 8. 依次弹出通知（每条用不同 tag 才能多条共存）──
  const name = (snapshot && snapshot.name) || npcName;
  for (let i = 0; i < messages.length; i++) {
    await self.registration.showNotification(name, {
      body: messages[i],
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'meow-' + npcId + '-' + Date.now() + '-' + i,
      renotify: true,  // 即使 tag 类似也要震动/响铃
      data: {
        npcId: npcId,
        action: 'open-chat',
        messageIndex: i,
        totalMessages: messages.length
      }
    });

    // ★ 多条之间加延迟，模拟真人连发节奏
    if (i < messages.length - 1) {
      const msgLen = messages[i].length;
      const delay = 2000 + msgLen * 100 + Math.floor(Math.random() * 2000);
      await sleep(Math.min(delay, 6000)); // 单条最多 6 秒
    }
  }

  // ── 9. 尝试通知前端页面 ──
  try {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({
        type: 'meow-messages-generated',
        npcId: npcId,
        messages: messages
      });
    }
  } catch (e) {}

  // ── 10. 预生成下一轮消息（如果时间允许）──
  if (apiConfig && apiConfig.apiKey && snapshot) {
    try {
      const nextMessages = await generateMessages(apiConfig, snapshot, globalCtx, 'prefetch', snapshotStale);
      if (nextMessages && nextMessages.length) {
        await idbPut('meow_sw_prefetch_' + npcId, {
          messages: nextMessages,
          generatedAt: Date.now()
        });
        console.log('[SW] 已预生成下一轮:', nextMessages.length, '条');
      }
    } catch (e) {
      // 预生成失败不影响本次推送
    }
  }
}


// ══════════════════════════════════════════════════════════════
//  调模型 API 生成多条消息
// ══════════════════════════════════════════════════════════════

async function generateMessages(apiConfig, snapshot, globalCtx, kind, snapshotStale) {
  const userName = (globalCtx && globalCtx.userName) || '你';
  const npcName = snapshot.name || '角色';

  // ── 构建 system prompt ──
  let systemParts = [];
  systemParts.push(
    '你是' + npcName + '，现在要主动找' + userName + '发消息。'
  );
  systemParts.push(
    '你的人设：\n' + (snapshot.profile || '（无详细设定）')
  );
  if (snapshot.onlineChatPrompt) {
    systemParts.push('聊天风格指南：\n' + snapshot.onlineChatPrompt);
  }
  if (snapshot.bond) {
    systemParts.push('你和' + userName + '目前的关系：' + snapshot.bond);
  }

  // 世界书 + 全局上下文
  if (globalCtx) {
    if (globalCtx.worldBook) {
      systemParts.push('世界观设定：\n' + globalCtx.worldBook.substring(0, 3000));
    }
    if (globalCtx.phoneWorldBook) {
      systemParts.push('补充设定：\n' + globalCtx.phoneWorldBook.substring(0, 2000));
    }
    if (globalCtx.worldState) {
      systemParts.push('当前世界状态：' + globalCtx.worldState);
    }
  }

  // 角色状态
  if (snapshot.npcState) {
    systemParts.push('你当前的状态：' + snapshot.npcState);
  }
  if (snapshot.currentScene) {
    systemParts.push('当前场景：' + snapshot.currentScene);
  }

  // 总结 + 最近记忆
  if (snapshot.summary) {
    systemParts.push('之前的聊天总结：\n' + snapshot.summary.substring(0, 2000));
  }
  if (snapshot.recentMemory) {
    systemParts.push('最近的对话：\n' + snapshot.recentMemory.substring(0, 1500));
  }

  if (snapshotStale) {
    systemParts.push('（注意：以上信息可能不是最新的，请基于已有信息合理推断）');
  }

  const systemPrompt = systemParts.join('\n\n');

  // ── 构建 user prompt ──
  const kindHints = {
    daily: '日常想找人聊天',
    social: '想和对方社交互动',
    lonely: '感到孤独想找人说话',
    event: '有事情想告诉对方',
    prefetch: '日常想找人聊天',
  };
  const kindHint = kindHints[kind] || kindHints.daily;

  const userPrompt = [
    '你现在' + kindHint + '，打开了和' + userName + '的聊天窗口。',
    '请生成一组你会连续发送的消息（2~5条），模拟真人自然连发的节奏。',
    '',
    '要求：',
    '- 第一条通常是称呼、叫人、打招呼（比如直接叫名字、"嘿"、"在吗"等）',
    '- 中间是你想说的正事或想聊的话题',
    '- 可以像真人一样断句分条发',
    '- 最后一条可以是追问、语气词、表情描述',
    '- 每条消息 5~40 字，不要太长',
    '- 语气完全贴合你的人设和说话风格',
    '- 不要生成任何元信息或括号注释',
    '',
    '只返回 JSON 数组格式，例如：',
    '["消息1","消息2","消息3"]',
    '',
    '不要返回任何其他内容，不要 markdown 包裹。'
  ].join('\n');

  // ── 调 API ──
  const isClaudeAPI = apiConfig.baseUrl.indexOf('anthropic') !== -1;

  let response;
  if (isClaudeAPI) {
    response = await callClaudeAPI(apiConfig, systemPrompt, userPrompt);
  } else {
    response = await callOpenAICompatAPI(apiConfig, systemPrompt, userPrompt);
  }

  // ── 解析 ──
  return parseMessageArray(response);
}


async function callOpenAICompatAPI(config, system, user) {
  const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.apiKey
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.85,
      max_tokens: 500
    })
  });

  if (!resp.ok) throw new Error('API HTTP ' + resp.status);
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message &&
          data.choices[0].message.content) || '';
}


async function callClaudeAPI(config, system, user) {
  const url = config.baseUrl.replace(/\/+$/, '') + '/v1/messages';

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.model || 'claude-sonnet-4-20250514',
      system: system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 500,
      temperature: 0.85
    })
  });

  if (!resp.ok) throw new Error('API HTTP ' + resp.status);
  const data = await resp.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}


function parseMessageArray(raw) {
  let text = String(raw || '').trim();
  // 去掉可能的 markdown 代码块包裹
  text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr
        .map(m => String(m || '').trim())
        .filter(m => m.length > 0)
        .slice(0, 5); // 最多 5 条
    }
  } catch (e) {}

  // JSON 解析失败，尝试按换行分割
  const lines = text.split('\n')
    .map(l => l.replace(/^[\d\.\-\*\s]+/, '').replace(/^["']|["']$/g, '').trim())
    .filter(l => l.length > 0 && l.length < 100);

  if (lines.length >= 2) return lines.slice(0, 5);

  // 实在解析不了，返回整段作为一条
  if (text.length > 0 && text.length < 200) return [text];

  return null; // 返回 null 表示失败，走兜底
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ══════════════════════════════════════════════════════════════
//  Notification Click — 点击通知打开聊天
// ══════════════════════════════════════════════════════════════

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const npcId = data.npcId || '';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // 如果已有窗口打开，聚焦并通知它
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({
            type: 'meow-open-chat',
            npcId: npcId
          });
          return;
        }
      }
      // 没有窗口，打开新的
      const url = npcId ? ('/?npc=' + encodeURIComponent(npcId)) : '/';
      return clients.openWindow(url);
    })
  );
});
