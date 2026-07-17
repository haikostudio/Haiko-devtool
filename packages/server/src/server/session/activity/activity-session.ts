import type { Logger } from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ActivityLogService } from "../../activity/service.js";

export interface ActivityLogSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ActivityLogSessionOptions {
  host: ActivityLogSessionHost;
  activityLogService: ActivityLogService;
  logger: Logger;
}

/**
 * A client's activity.* request surface: fetch the global log and subscribe to
 * live upserts. Subscriptions are torn down on socket close via dispose().
 */
export class ActivityLogSession {
  private readonly host: ActivityLogSessionHost;
  private readonly activityLogService: ActivityLogService;
  private readonly logger: Logger;
  private readonly subscriptions = new Map<string, () => void>();

  constructor(options: ActivityLogSessionOptions) {
    this.host = options.host;
    this.activityLogService = options.activityLogService;
    this.logger = options.logger;
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) {
      unsubscribe();
    }
    this.subscriptions.clear();
  }

  private emitRpcError(request: { requestId: string; type: string }, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Activity log request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "activity_request_failed",
      },
    });
  }

  async handleGetRequest(
    request: Extract<SessionInboundMessage, { type: "activity.log.get.request" }>,
  ): Promise<void> {
    try {
      const entries = await this.activityLogService.list();
      this.host.emit({
        type: "activity.log.get.response",
        payload: { requestId: request.requestId, entries, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  async handleSubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "activity.log.subscribe.request" }>,
  ): Promise<void> {
    try {
      const existing = this.subscriptions.get(request.subscriptionId);
      if (existing) {
        existing();
        this.subscriptions.delete(request.subscriptionId);
      }
      const unsubscribe = this.activityLogService.subscribe((entry) => {
        this.host.emit({
          type: "activity.log.update",
          payload: { subscriptionId: request.subscriptionId, entry },
        });
      });
      this.subscriptions.set(request.subscriptionId, unsubscribe);
      const entries = await this.activityLogService.list();
      this.host.emit({
        type: "activity.log.subscribe.response",
        payload: { requestId: request.requestId, entries, error: null },
      });
    } catch (error) {
      this.emitRpcError(request, error);
    }
  }

  handleUnsubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "activity.log.unsubscribe.request" }>,
  ): void {
    const unsubscribe = this.subscriptions.get(request.subscriptionId);
    if (unsubscribe) {
      unsubscribe();
      this.subscriptions.delete(request.subscriptionId);
    }
    this.host.emit({
      type: "activity.log.unsubscribe.response",
      payload: { requestId: request.requestId, error: null },
    });
  }
}
