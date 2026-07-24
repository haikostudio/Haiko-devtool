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

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? (await navigator.serviceWorker.register("/sw.js"));
}

async function postSubscription(subscription: PushSubscription): Promise<void> {
  await fetch("/push/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });
}

// Quick, synchronous best-effort. Never claims "enabled" — a granted browser
// permission does NOT mean an active push subscription exists. Real "enabled"
// is only confirmed by syncWebPushState() once a subscription is found.
export function getWebPushState(): WebPushState {
  if (!isSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "default";
}

// Reflects the REAL state: "enabled" only when an active push subscription
// exists. When one does, re-post it so the server copy stays in sync.
export async function syncWebPushState(): Promise<WebPushState> {
  if (!isSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "default";
  try {
    const registration = await getRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return "default";
    await postSubscription(subscription);
    return "enabled";
  } catch {
    return "default";
  }
}

export async function enableWebPush(): Promise<WebPushState> {
  if (!isSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "default";
  }

  const registration = await getRegistration();
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

  await postSubscription(subscription);
  return "enabled";
}
