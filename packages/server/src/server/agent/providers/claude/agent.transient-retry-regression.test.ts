import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

interface QueryMock {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>, void>;
}

interface PromptRecord {
  text: string;
  uuid: string | null;
}

interface AsyncQueue<T> {
  push: (value: T) => void;
  next: () => Promise<IteratorResult<T, void>>;
  end: () => void;
}

type ScriptedQuery = QueryMock & {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  prompts: PromptRecord[];
};

const queryFactory = vi.fn();

function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  let ended = false;

  return {
    push(value) {
      if (ended) {
        return;
      }
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value, done: false });
        return;
      }
      items.push(value);
    },
    async next() {
      const value = items.shift();
      if (value !== undefined) {
        return { value, done: false };
      }
      if (ended) {
        return { value: undefined, done: true };
      }
      return await new Promise<IteratorResult<T, void>>((resolve) => {
        resolvers.push(resolve);
      });
    },
    end() {
      ended = true;
      while (resolvers.length > 0) {
        const resolve = resolvers.shift();
        resolve?.({ value: undefined, done: true });
      }
    },
  };
}

function buildUsage() {
  return {
    input_tokens: 1,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  };
}

function buildSuccessResult(sessionId: string) {
  return {
    type: "result",
    subtype: "success",
    usage: buildUsage(),
    total_cost_usd: 0,
    session_id: sessionId,
  };
}

function extractPromptText(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      break;
    }
  }
  return events;
}

function collectAssistantText(events: AgentStreamEvent[]): string {
  return events
    .flatMap((event) => {
      if (event.type !== "timeline" || event.item.type !== "assistant_message") {
        return [];
      }
      return [event.item.text];
    })
    .join("");
}

interface TransientQueryOptions {
  callIndex: number;
  prompt: AsyncIterable<unknown>;
  prompts: PromptRecord[];
  sessionId: string;
  crashOnDrain: boolean;
  crashError: string;
  answerText?: string;
}

function createTransientScriptedQuery(options: TransientQueryOptions): ScriptedQuery {
  const output = createAsyncQueue<Record<string, unknown>>();
  let nextCalls = 0;

  const scriptedQuery = {
    next: vi.fn(async () => {
      nextCalls += 1;
      // Deliver the init message first, then crash the stream so the pump sees
      // a transient SDK failure exactly like the real "null push" glitch.
      if (options.crashOnDrain && nextCalls > 1) {
        throw new Error(options.crashError);
      }
      return output.next();
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => {
      output.end();
    }),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    emit: (message: Record<string, unknown>) => {
      output.push(message);
    },
    end: () => {
      output.end();
    },
    prompts: options.prompts,
    [Symbol.asyncIterator]() {
      return this;
    },
  } satisfies ScriptedQuery;

  scriptedQuery.emit({
    type: "system",
    subtype: "init",
    session_id: options.sessionId,
    permissionMode: "default",
    model: "opus",
  });

  void (async () => {
    for await (const promptMessage of options.prompt) {
      const record = promptMessage as Record<string, unknown>;
      const promptRecord = {
        text: extractPromptText(record),
        uuid: typeof record.uuid === "string" ? record.uuid : null,
      };
      options.prompts.push(promptRecord);

      if (options.answerText !== undefined) {
        output.push({
          type: "assistant",
          message: { content: options.answerText },
          session_id: options.sessionId,
        });
        output.push(buildSuccessResult(options.sessionId));
      }
    }
  })();

  return scriptedQuery;
}

afterEach(() => {
  queryFactory.mockReset();
});

test("retries a foreground turn once when the SDK query crashes with a transient null push error", async () => {
  const logger = createTestLogger();
  const prompts: PromptRecord[] = [];
  let factoryCalls = 0;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    factoryCalls += 1;
    const callIndex = factoryCalls;
    return createTransientScriptedQuery({
      callIndex,
      prompt,
      prompts,
      sessionId: "transient-retry-session",
      // First query dies to the transient glitch; the resubmitted turn runs on
      // the freshly rebuilt second query.
      crashOnDrain: callIndex === 1,
      crashError: "Cannot read properties of null (reading 'push')",
      answerText: callIndex === 2 ? "RECOVERED_RESPONSE" : undefined,
    });
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const events = await collectUntilTerminal(streamSession(session, "hello"));

  // A fresh query was created for the retry and the same prompt was resubmitted.
  expect(factoryCalls).toBe(2);
  expect(prompts.map((prompt) => prompt.text)).toEqual(["hello", "hello"]);
  // The user sees a normal completion, not a "[System Error]".
  expect(events.some((event) => event.type === "turn_failed")).toBe(false);
  expect(events.some((event) => event.type === "turn_completed")).toBe(true);
  expect(collectAssistantText(events)).toContain("RECOVERED_RESPONSE");
  expect(collectAssistantText(events)).not.toContain("System Error");

  await session.close();
});

test("gives up after a single retry when the transient error keeps recurring", async () => {
  const logger = createTestLogger();
  const prompts: PromptRecord[] = [];
  let factoryCalls = 0;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    factoryCalls += 1;
    const callIndex = factoryCalls;
    return createTransientScriptedQuery({
      callIndex,
      prompt,
      prompts,
      sessionId: "transient-retry-give-up-session",
      // Every query crashes: retry once, then surface the failure.
      crashOnDrain: true,
      crashError: "Cannot read properties of null (reading 'push')",
    });
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const events = await collectUntilTerminal(streamSession(session, "hello"));

  // Exactly one retry: the original query plus a single rebuilt query.
  expect(factoryCalls).toBe(2);
  expect(events.some((event) => event.type === "turn_failed")).toBe(true);

  await session.close();
});

test("does not retry a genuine non-transient failure", async () => {
  const logger = createTestLogger();
  const prompts: PromptRecord[] = [];
  let factoryCalls = 0;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    factoryCalls += 1;
    const callIndex = factoryCalls;
    return createTransientScriptedQuery({
      callIndex,
      prompt,
      prompts,
      sessionId: "non-transient-session",
      crashOnDrain: callIndex === 1,
      crashError: "process exited with code 1",
    });
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const events = await collectUntilTerminal(streamSession(session, "hello"));

  // No rebuild, no retry: a real failure surfaces immediately.
  expect(factoryCalls).toBe(1);
  expect(events.some((event) => event.type === "turn_failed")).toBe(true);

  await session.close();
});
