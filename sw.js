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
  const text    = payload.text    || payload.body  || '';

  if (!text) return;

  // 存 IDB
  try {
    await idbPut('meow_sw_pending_msgs_' + npcId, {
      npcId, messages: [text], generatedAt: Date.now(), kind: payload.kind || 'bgpush'
    });
  } catch (e) {}

  // 弹通知
  await self.registration.showNotification(npcName, {
    body: text,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'meow-' + npcId + '-' + Date.now(),
    renotify: true,
    data: { npcId, action: 'open-chat' }
  });

  // 通知前端
  try {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'meow-messages-generated', npcId, messages: [text] });
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
