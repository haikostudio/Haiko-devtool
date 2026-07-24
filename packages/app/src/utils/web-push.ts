// Native/base stub. Web Push is a browser-only capability; on iOS/Android the
// app uses Expo push instead. The real implementation lives in web-push.web.ts.

export type WebPushState = "unsupported" | "default" | "denied" | "enabled";

export function getWebPushState(): WebPushState {
  return "unsupported";
}

export async function syncWebPushState(): Promise<WebPushState> {
  return "unsupported";
}

export async function enableWebPush(): Promise<WebPushState> {
  return "unsupported";
}
