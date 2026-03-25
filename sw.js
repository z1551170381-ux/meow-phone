// ====== sw.js — 喵喵推送 v4 Service Worker ======
// 极简：收到 push → 显示 payload.text → 存 IDB → 通知前端
// ★ 不调任何 API

const DB_NAME = 'meow_phone_db';
const DB_VERSION = 1;
const KV_STORE = 'kv';

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

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));

// ═══════════ Push Event ═══════════

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (e) { try { payload = { text: event.data.text() }; } catch (e2) {} }

  const npcId   = payload.npcId   || '';
  const npcName = payload.npcName || payload.title || '消息';
  let rawText   = payload.text    || payload.body  || '';

  if (!rawText) return;

  // text 可能是 JSON 数组字符串（连发多条）
  let messages = [rawText];
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed) && parsed.length) {
      messages = parsed.map(m => String(m || '').trim()).filter(m => m.length > 0);
    }
  } catch(e) {}

  if (!messages.length) return;

  // 存 IDB
  try {
    await idbPut('meow_sw_pending_msgs_' + npcId, {
      npcId, messages, generatedAt: Date.now(), kind: payload.kind || 'bgpush'
    });
  } catch (e) {}

  // 逐条弹通知（模拟真人连发）
  for (let i = 0; i < messages.length; i++) {
    await self.registration.showNotification(npcName, {
      body: messages[i],
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'meow-' + npcId + '-' + Date.now() + '-' + i,
      renotify: true,
      data: { npcId, action: 'open-chat', messageIndex: i }
    });
    // 多条之间短暂延迟
    if (i < messages.length - 1) {
      await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 2000)));
    }
  }

  // 通知前端
  try {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'meow-messages-generated', npcId, messages });
    }
  } catch (e) {}
}

// ═══════════ Notification Click ═══════════

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const npcId = data.npcId || '';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'meow-open-chat', npcId });
          return;
        }
      }
      return clients.openWindow(npcId ? '/?npc=' + encodeURIComponent(npcId) : '/');
    })
  );
});
