// Browser Web Push opt-in. Registers the service worker, asks for notification
// permission (must be triggered by a user gesture — hence the Settings button),
// subscribes with the VAPID public key served at /push/vapid-public, and posts
// the subscription to /push/register on the same origin (the self-host receiver
// behind Caddy). Entirely origin-local; the daemon is not involved.

export type WebPushState = "unsupported" | "default" | "denied" | "enabled";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function getWebPushState(): WebPushState {
  if (!isSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted") return "enabled";
  return "default";
}

export async function enableWebPush(): Promise<WebPushState> {
  if (!isSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "default";
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const res = await fetch("/push/vapid-public");
  const { publicKey } = (await res.json()) as { publicKey: string };

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  await fetch("/push/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });

  return "enabled";
}
