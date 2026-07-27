import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

// Regression: picking a thinking level (or a model) on a freshly created agent
// set `queryRestartNeeded` while no query existed yet. ensureQuery() only
// cleared the flag on its restart branch, so the first prompt built a query with
// the flag still set; startQueryPump()'s own ensureQuery() then immediately tore
// that query down, nulling `this.input` before startTurn pushed the message.
// The user saw "[System Error] La connexion à Claude a été perdue — réessaie."
// on the very first prompt of every conductor agent.

const queryFactory = vi.fn();

interface AsyncQueue<T> {
  push: (value: T) => void;
  next: () => Promise<IteratorResult<T, void>>;
  end: () => void;
}

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

function createScriptedQuery(options: {
  prompt: AsyncIterable<unknown>;
  prompts: string[];
  sessionId: string;
}) {
  const output = createAsyncQueue<Record<string, unknown>>();

  const scriptedQuery = {
    next: vi.fn(async () => output.next()),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => {
      output.end();
    }),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "sonnet", displayName: "Sonnet" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    applyFlagSettings: vi.fn(async () => undefined),
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  output.push({
    type: "system",
    subtype: "init",
    session_id: options.sessionId,
    permissionMode: "default",
    model: "sonnet",
  });

  void (async () => {
    for await (const promptMessage of options.prompt) {
      const record = promptMessage as Record<string, unknown>;
      options.prompts.push(extractPromptText(record));
      output.push({
        type: "assistant",
        message: { content: "ANSWER" },
        session_id: options.sessionId,
      });
      output.push({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        total_cost_usd: 0,
        session_id: options.sessionId,
      });
    }
  })();

  return scriptedQuery;
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

afterEach(() => {
  queryFactory.mockReset();
});

test("the first prompt still runs after the thinking level is set on a brand new session", async () => {
  const logger = createTestLogger();
  const prompts: string[] = [];
  let factoryCalls = 0;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    factoryCalls += 1;
    return createScriptedQuery({
      prompt,
      prompts,
      sessionId: "thinking-before-first-turn-session",
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
    model: "sonnet",
  });

  // No query exists yet — exactly what the conductor does right after creation.
  await session.setThinkingOption?.("high");

  const events = await collectUntilTerminal(streamSession(session, "bonjour"));

  // The turn runs on a single query: no self-inflicted restart mid-turn.
  expect(factoryCalls).toBe(1);
  expect(prompts).toEqual(["bonjour"]);
  expect(events.some((event) => event.type === "turn_failed")).toBe(false);
  expect(events.some((event) => event.type === "turn_completed")).toBe(true);

  await session.close();
});
