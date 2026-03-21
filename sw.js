// 喵喵小手机 Service Worker v5
// SW 收到推送后主动拉取消息内容，不依赖 payload

self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e) {
  // 先尝试从 payload 读内容
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
      try { var t = e.data.text(); if (t) { var p = JSON.parse(t); if(p.npcName) npcName=p.npcName; if(p.text) text=p.text; if(p.npcId) npcId=p.npcId; } } catch(e2) {}
    }
  }

  // 如果 payload 没有内容，主动拉取最新消息
  var showNotification = function(name, body, id) {
    return self.registration.showNotification(name, {
      body:     body,
      icon:     '/icon-192.png',
      badge:    '/icon-192.png',
      tag:      'meow-' + (id || 'msg'),
      renotify: true,
      data:     { npcId: id },
      vibrate:  [200, 100, 200]
    });
  };

  if (text === '有新消息，点击查看') {
    // payload 没内容，主动拉取
    e.waitUntil(
      fetch('/api/pull?uid=standalone_main')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok && data.messages && data.messages.length > 0) {
            var msg = data.messages[0];
            return showNotification(
              msg.npcName || '喵喵小手机',
              msg.text    || '有新消息',
              msg.npcId   || ''
            );
          }
          return showNotification(npcName, text, npcId);
        })
        .catch(function() {
          return showNotification(npcName, text, npcId);
        })
    );
  } else {
    e.waitUntil(showNotification(npcName, text, npcId));
  }
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var npcId = e.notification.data && e.notification.data.npcId;
  var url = npcId ? ('/?npc=' + encodeURIComponent(npcId)) : '/';
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(clients) {
      for (var i = 0; i < clients.length; i++) {
        if ('focus' in clients[i]) {
          clients[i].focus();
          if (clients[i].navigate) clients[i].navigate(url);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
