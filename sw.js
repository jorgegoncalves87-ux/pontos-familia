// Service worker: mostra as notificações enviadas pelo notificador (notifier/notify.mjs).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { data: { body: event.data ? event.data.text() : "" } }; }
  const d = msg.data || {}, n = msg.notification || {};
  // No iPhone, cada push tem de mostrar uma notificação, senão o sistema corta a autorização.
  event.waitUntil(self.registration.showNotification(d.title || n.title || "Pontos da Família", {
    body: d.body || n.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || undefined,
    data: { link: d.link || self.registration.scope },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data?.link || self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(link);
  }));
});
