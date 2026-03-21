// 喵喵小手机 Service Worker v6
// iOS 要求：push handler 必须同步调用 showNotification，不能有任何 fetch 在前面

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


  // 直接弹通知，不 fetch
  // proactive.js 已在 payload 里带了 npcName/text/npcId
  // 即使 payload 为空，也用默认文案立即弹，iOS 才不会丢掉这条通知
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
