import type pino from "pino";

import type { PushNotificationHistoryStore } from "./notification-history-store.js";
import { PushService, type PushPayload } from "./push-service.js";
import type { PushTokenStore } from "./token-store.js";

export type { PushPayload };

export interface PushNotificationSender {
  send(payload: PushPayload): Promise<void>;
}

export function createPushNotificationSender(
  logger: pino.Logger,
  tokenStore: PushTokenStore,
  historyStore?: PushNotificationHistoryStore,
): PushNotificationSender {
  const pushService = new PushService(logger, tokenStore);

  return {
    async send(payload) {
      // Record every dispatched notification so the mobile history panel lists it,
      // regardless of how many devices are currently registered.
      historyStore?.record(payload);

      const tokens = tokenStore.getAllTokens();
      logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) {
        return;
      }

      await pushService.sendPush(tokens, payload);
    },
  };
}
