self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const windows = await clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    // If VEIL is already visible, let the in-page XMTP stream update the chat
    // instead of showing a redundant system notification.
    if (windows.some((client) => client.visibilityState === "visible")) return;

    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch {}

    await self.registration.showNotification("SCHIZORA · VEIL", {
      body: "New encrypted message received. Open VEIL to decrypt.",
      tag: "schizora-veil-message",
      renotify: true,
      data: { url: data.url || "/#veil" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/#veil";

  event.waitUntil((async () => {
    const windows = await clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    for (const client of windows) {
      if ("navigate" in client) {
        try { await client.navigate(target); } catch {}
      }
      if ("focus" in client) return client.focus();
    }

    return clients.openWindow(target);
  })());
});
