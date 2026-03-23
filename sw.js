// 喵喵小手机 Service Worker v8
// ★ 加密 push 在 SW 层浏览器自动解密，e.data 拿到的已是明文
// ★ 兼容：有 payload → 直接用；没有/解析失败 → 主动 pull

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

// 收到 meow-open-chat 消息时，向所有页面广播让前端跳转
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'meow-open-chat') {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      clients.forEach(function(client) {
        try { client.postMessage(e.data); } catch(_) {}
      });
    });
  }
});

function _targetUrl(npcId) {
  return new URL(
    npcId ? ('/?npc=' + encodeURIComponent(npcId)) : '/',
    self.registration.scope
  ).href;
}

function _showNotification(name, body, id) {
  return self.registration.showNotification(name || '喵喵小手机', {
    body:     body || '有新消息，点击查看',
    icon:     '/icon-192.png',
    badge:    '/icon-192.png',
    tag:      'meow-' + (id || 'msg'),
    renotify: true,
    data:     { npcId: id || '' },
    vibrate:  [200, 100, 200]
  });
}

self.addEventListener('push', function(e) {
  var npcName = '喵喵小手机';
  var text    = '';       // 空时走 pull 兜底
  var npcId   = '';
  var parsed  = false;

  // ★ 加密 push 经浏览器自动解密后，e.data 直接是明文 JSON
  if (e.data) {
    // 先尝试 json()
    try {
      var payload = e.data.json();
      if (payload) {
        if (payload.npcName) npcName = payload.npcName;
        if (payload.text)    text    = payload.text;
        if (payload.npcId)   npcId   = payload.npcId;
        // 兼容旧字段 body
        if (!text && payload.body) text = payload.body;
        parsed = true;
      }
    } catch (_) {}

    // json() 失败时尝试 text()
    if (!parsed) {
      try {
        var raw = e.data.text();
        if (raw && raw.trim().startsWith('{')) {
          var p2 = JSON.parse(raw);
          if (p2.npcName) npcName = p2.npcName;
          if (p2.text)    text    = p2.text;
          if (p2.npcId)   npcId   = p2.npcId;
          if (!text && p2.body) text = p2.body;
          parsed = true;
        }
      } catch (_) {}
    }
  }

  // 有完整 payload 直接显示，不用再 pull
  if (parsed && text) {
    e.waitUntil(_showNotification(npcName, text, npcId));
    return;
  }

  // 没有 payload 或解析失败 → 主动 pull 最新消息
  e.waitUntil(
    fetch('/api/pull?uid=standalone_main', { cache: 'no-store', credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.ok && data.messages && data.messages.length > 0) {
          var msg = data.messages[data.messages.length - 1] || {};
          return _showNotification(
            msg.npcName || npcName,
            msg.text    || '有新消息，点击查看',
            msg.npcId   || npcId
          );
        }
        return _showNotification(npcName, '有新消息，点击查看', npcId);
      })
      .catch(function() {
        return _showNotification(npcName, '有新消息，点击查看', npcId);
      })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var npcId     = (e.notification.data && e.notification.data.npcId) || '';
  var targetUrl = _targetUrl(npcId);

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      if (clients && clients.length) {
        var client = clients[0];
        return Promise.resolve(client.focus && client.focus())
          .then(function() {
            // 通知前端跳到对应聊天
            try { client.postMessage({ type: 'meow-open-chat', npcId: npcId }); } catch(_) {}
            if (client.navigate && client.url !== targetUrl) {
              return client.navigate(targetUrl);
            }
          });
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
