import { describe, expect, it } from "vitest";

import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  appendOptimisticUserMessageToStream,
  buildOptimisticUserMessage,
  reduceStreamUpdate,
  type StreamItem,
  type UserMessageItem,
} from "./stream";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";
const TS = new Date("2025-01-01T12:00:00Z");

function userTimelineEvent(item: {
  text: string;
  messageId?: string;
  images?: { data: string; mimeType: string }[];
}): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "user_message", ...item },
  } as AgentStreamEventPayload;
}

function onlyUserMessage(state: StreamItem[]): UserMessageItem {
  const messages = state.filter((item): item is UserMessageItem => item.kind === "user_message");
  expect(messages).toHaveLength(1);
  return messages[0];
}

describe("user message images from the server timeline", () => {
  it("renders server images as remote data URIs when there is no local copy", () => {
    const state = reduceStreamUpdate(
      [],
      userTimelineEvent({
        text: "look",
        messageId: "m1",
        images: [{ data: PNG, mimeType: "image/png" }],
      }),
      TS,
    );

    const message = onlyUserMessage(state);
    expect(message.images).toBeUndefined();
    expect(message.remoteImages).toEqual([
      { id: "m1:img:0", mimeType: "image/png", dataUrl: `data:image/png;base64,${PNG}` },
    ]);
  });

  it("keeps an image-only message (empty text) instead of dropping it", () => {
    const state = reduceStreamUpdate(
      [],
      userTimelineEvent({
        text: "",
        messageId: "m2",
        images: [{ data: PNG, mimeType: "image/png" }],
      }),
      TS,
    );

    const message = onlyUserMessage(state);
    expect(message.text).toBe("");
    expect(message.remoteImages).toHaveLength(1);
  });

  it("adds no remote images for a plain text message", () => {
    const state = reduceStreamUpdate([], userTimelineEvent({ text: "hi", messageId: "m3" }), TS);

    const message = onlyUserMessage(state);
    expect(message.remoteImages).toBeUndefined();
  });

  it("keeps the sender's local optimistic image and ignores the redundant server bytes", () => {
    const localImage: AttachmentMetadata = {
      id: "att_local",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "key_local",
      createdAt: 0,
    };
    const optimistic = buildOptimisticUserMessage({
      id: "m4",
      text: "look",
      timestamp: TS,
      images: [localImage],
    });
    const { tail } = appendOptimisticUserMessageToStream({
      tail: [],
      head: [],
      message: optimistic,
      placement: "tail",
    });

    const state = reduceStreamUpdate(
      tail,
      userTimelineEvent({
        text: "look",
        messageId: "m4",
        images: [{ data: PNG, mimeType: "image/png" }],
      }),
      TS,
    );

    const message = onlyUserMessage(state);
    expect(message.optimistic).toBeUndefined();
    expect(message.images).toEqual([localImage]);
    expect(message.remoteImages).toBeUndefined();
  });
});
