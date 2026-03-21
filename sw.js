// 喵喵小手机 Service Worker v2
// 修复：即使 payload 为空也能弹通知

self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e) {
  var npcName = '喵喵小手机';
  var text    = '有新消息，点击查看';
  var npcId   = '';

  if (e.data) {
    try {
      var payload = e.data.json();
      npcName = payload.npcName || npcName;
      text    = payload.text    || text;
      npcId   = payload.npcId   || '';
    } catch(err) {
      try { var raw = e.data.text(); if (raw) text = raw; } catch(e2) {}
    }
  }

  e.waitUntil(
    self.registration.showNotification(npcName, {
      body:     text,
      icon:     '/icon-192.png',
      badge:    '/icon-192.png',
      tag:      'meow-' + (npcId || 'msg'),
      renotify: true,
      data:     { npcId: npcId },
      vibrate:  [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var npcId = e.notification.data && e.notification.data.npcId;
  var url = npcId ? ('/?npc=' + encodeURIComponent(npcId)) : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      for (var i = 0; i < clients.length; i++) {
        if ('focus' in clients[i]) { clients[i].focus(); if (clients[i].navigate) clients[i].navigate(url); return; }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
