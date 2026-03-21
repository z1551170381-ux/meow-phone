// 喵喵小手机 Service Worker v7
// 优先用 payload；没有 payload 时再主动拉取最新消息

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

function _targetUrl(npcId) {
  return new URL(npcId ? ('/?npc=' + encodeURIComponent(npcId)) : '/', self.registration.scope).href;
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
  var text    = '有新消息，点击查看';
  var npcId   = '';

  if (e.data) {
    try {
      var payload = e.data.json();
      if (payload.npcName) npcName = payload.npcName;
      if (payload.text)    text    = payload.text;
      if (payload.npcId)   npcId   = payload.npcId;
    } catch(err) {
      try {
        var t = e.data.text();
        if (t) {
          var p = JSON.parse(t);
          if (p.npcName) npcName = p.npcName;
          if (p.text)    text    = p.text;
          if (p.npcId)   npcId   = p.npcId;
        }
      } catch(e2) {}
    }
  }

  if (npcId && text !== '有新消息，点击查看') {
    e.waitUntil(_showNotification(npcName, text, npcId));
    return;
  }

  e.waitUntil(
    fetch('/api/pull?uid=standalone_main', { cache: 'no-store', credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.ok && data.messages && data.messages.length > 0) {
          var msg = data.messages[data.messages.length - 1] || {};
          return _showNotification(
            msg.npcName || npcName,
            msg.text    || text,
            msg.npcId   || npcId
          );
        }
        return _showNotification(npcName, text, npcId);
      })
      .catch(function() {
        return _showNotification(npcName, text, npcId);
      })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var npcId = e.notification.data && e.notification.data.npcId || '';
  var targetUrl = _targetUrl(npcId);

  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(clients) {
      if (clients && clients.length) {
        var client = clients[0];
        return Promise.resolve(client.focus && client.focus())
          .then(function() {
            try {
              client.postMessage({ type: 'meow-open-chat', npcId: npcId });
            } catch(err) {}
            if (client.navigate && client.url !== targetUrl) {
              return client.navigate(targetUrl);
            }
          });
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});