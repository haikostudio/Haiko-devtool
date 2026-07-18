import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type {
  AgentPromptInput,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";

// The image bytes leave Paseo in the outgoing prompt and come back on the echoed
// user turn keyed by the same uuid; these helpers exercise both halves so we
// prove the persisted user_message re-carries the images for every client.
interface ClaudeImageAttachmentTestSession {
  toSdkUserMessage(prompt: AgentPromptInput): { uuid: string };
  translateMessageToEvents(message: SDKMessage): AgentStreamEvent[];
}

async function createSession(): Promise<ClaudeImageAttachmentTestSession> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  return session as unknown as ClaudeImageAttachmentTestSession;
}

function userEcho(uuid: string, content: unknown): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content },
    uuid,
    session_id: "session-1",
  } as unknown as SDKMessage;
}

function imageBlock(): unknown {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
  };
}

function userMessages(
  events: AgentStreamEvent[],
): Array<Extract<AgentTimelineItem, { type: "user_message" }>> {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
        event.type === "timeline",
    )
    .map((event) => event.item)
    .filter(
      (item): item is Extract<AgentTimelineItem, { type: "user_message" }> =>
        item.type === "user_message",
    );
}

describe("Claude user message image attachments", () => {
  test("re-attaches sent images to the echoed text+image user message", async () => {
    const session = await createSession();

    const { uuid } = session.toSdkUserMessage([
      { type: "text", text: "check this out" },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    const events = session.translateMessageToEvents(
      userEcho(uuid, [{ type: "text", text: "check this out" }, imageBlock()]),
    );

    const [message, ...extra] = userMessages(events);
    expect(extra).toEqual([]);
    expect(message.text).toBe("check this out");
    expect(message.images).toEqual([{ data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" }]);
  });

  test("emits an image-only user message when the prompt has no text", async () => {
    const session = await createSession();

    const { uuid } = session.toSdkUserMessage([
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    const events = session.translateMessageToEvents(userEcho(uuid, [imageBlock()]));

    const [message, ...extra] = userMessages(events);
    expect(extra).toEqual([]);
    expect(message.text).toBe("");
    expect(message.images).toEqual([{ data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" }]);
  });

  test("leaves images undefined for a plain text message", async () => {
    const session = await createSession();

    const { uuid } = session.toSdkUserMessage("just text");

    const events = session.translateMessageToEvents(userEcho(uuid, "just text"));

    const [message, ...extra] = userMessages(events);
    expect(extra).toEqual([]);
    expect(message.text).toBe("just text");
    expect(message.images).toBeUndefined();
  });
});
