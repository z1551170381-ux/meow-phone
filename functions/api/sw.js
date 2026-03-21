// 喵喵小手机 Service Worker v3

self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e) {
  var npcName = '喵喵小手机';
  var text    = '有新消息，点击查看';
  var npcId   = '';

  if (e.data) {
    // 多种方式尝试解析
    var raw = '';
    try { raw = e.data.text(); } catch(e1) {}

    if (raw) {
      // 尝试 JSON 解析
      try {
        var payload = JSON.parse(raw);
        if (payload.npcName) npcName = payload.npcName;
        if (payload.text)    text    = payload.text;
        if (payload.npcId)   npcId   = payload.npcId;
      } catch(e2) {
        // 不是 JSON，直接用原始文本
        text = raw;
      }
    } else {
      // 尝试 json() 方法
      try {
        var payload2 = e.data.json();
        if (payload2.npcName) npcName = payload2.npcName;
        if (payload2.text)    text    = payload2.text;
        if (payload2.npcId)   npcId   = payload2.npcId;
      } catch(e3) {}
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
