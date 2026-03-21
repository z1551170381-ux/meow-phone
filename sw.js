// 喵喵小手机 Service Worker v1.0
// 负责：接收后台推送、弹系统通知、点击跳转聊天

const SW_VERSION = 'meow-sw-v1';

// ========== 安装 & 激活 ==========
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(self.clients.claim());
});

// ========== 接收推送消息 ==========
// 后端发来的 payload 格式：
// { npcId: "角色id", npcName: "角色名", text: "消息内容", avatar: "头像url或首字" }
self.addEventListener('push', function(e) {
  if (!e.data) return;

  let payload = {};
  try {
    payload = e.data.json();
  } catch(err) {
    payload = { npcName: '喵喵', text: e.data.text() || '你有一条新消息' };
  }

  const npcName = payload.npcName || '喵喵';
  const text    = payload.text    || '你有一条新消息';
  const npcId   = payload.npcId  || '';

  const options = {
    body: text,
    icon: '/icon-192.png',      // 后面阶段2会让你生成图标
    badge: '/badge-72.png',
    tag: 'meow-' + npcId,       // 同一角色的通知会合并，不会刷屏
    renotify: true,
    data: { npcId: npcId },
    // Android 震动节奏
    vibrate: [200, 100, 200],
  };

  e.waitUntil(
    self.registration.showNotification(npcName, options)
  );
});

// ========== 点击通知 → 打开/聚焦页面 ==========
self.addEventListener('notificationclick', function(e) {
  e.notification.close();

  const npcId = e.notification.data && e.notification.data.npcId;
  // 跳转 URL，前端读取 ?npc= 参数自动打开对应聊天
  const targetUrl = npcId ? ('/?npc=' + encodeURIComponent(npcId)) : '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        // 如果页面已经开着，聚焦并导航
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if ('focus' in client) {
            client.focus();
            client.navigate && client.navigate(targetUrl);
            return;
          }
        }
        // 页面没开着，打开新窗口
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});
