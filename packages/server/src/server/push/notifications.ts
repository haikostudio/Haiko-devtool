import type pino from "pino";

import type { PushHistoryContext } from "./notification-history-context.js";
import type { PushNotificationHistoryStore } from "./notification-history-store.js";
import { PushService, type PushPayload } from "./push-service.js";
import type { PushTokenStore } from "./token-store.js";

export type { PushPayload, PushHistoryContext };

export interface PushNotificationSender {
  /**
   * Dispatch a push. `context` never reaches the device — it is recorded with
   * the history entry so the in-app panel can show task/project/recap.
   */
  send(payload: PushPayload, context?: PushHistoryContext): Promise<void>;
}

export function createPushNotificationSender(
  logger: pino.Logger,
  tokenStore: PushTokenStore,
  historyStore?: PushNotificationHistoryStore,
): PushNotificationSender {
  const pushService = new PushService(logger, tokenStore);

  return {
    async send(payload, context) {
      // Record every dispatched notification so the mobile history panel lists it,
      // regardless of how many devices are currently registered.
      historyStore?.record(payload, context);

      const tokens = tokenStore.getAllTokens();
      logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) {
        return;
      }

      await pushService.sendPush(tokens, payload);
    },
  };
}
