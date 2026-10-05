// Web Notification shim backed by the desktop `notify` command.
(() => {
  const shown = new Map();
  window.__btmuxNotificationDone = (id, clicked) => {
    const notification = shown.get(id);
    shown.delete(id);
    if (clicked) notification?.onclick?.();
  };
  class DesktopNotification {
    static permission = 'granted';
    static requestPermission() {
      return Promise.resolve('granted');
    }
    constructor(title, options = {}) {
      const id = crypto.randomUUID();
      this.title = title;
      this.body = options.body ?? '';
      this.tag = options.tag ?? '';
      this.onclick = null;
      shown.set(id, this);
      window.__TAURI_INTERNALS__
        .invoke('notify', { id, title, body: this.body })
        .catch(() => shown.delete(id));
    }
    close() {}
  }
  window.Notification = DesktopNotification;
})();
