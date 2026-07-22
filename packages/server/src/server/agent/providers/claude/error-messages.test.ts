import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_ERROR_MESSAGE,
  isClaudeAbortMessage,
  toReadableClaudeError,
} from "./error-messages.js";

describe("toReadableClaudeError", () => {
  it("rewrites internal null-property crashes to the default message", () => {
    expect(toReadableClaudeError("Cannot read properties of null (reading 'push')")).toBe(
      DEFAULT_CLAUDE_ERROR_MESSAGE,
    );
    expect(toReadableClaudeError("Cannot read properties of undefined (reading 'map')")).toBe(
      DEFAULT_CLAUDE_ERROR_MESSAGE,
    );
  });

  it("maps raw runtime crashes with no specific pattern to the default message", () => {
    expect(toReadableClaudeError("ReferenceError: foo\n  at bar (baz.js:2)")).toBe(
      DEFAULT_CLAUDE_ERROR_MESSAGE,
    );
  });

  it("passes through deliberate human-readable provider messages unchanged", () => {
    const message =
      "Claude Auto mode requires the Anthropic API and is not supported when Claude Code uses Vertex";
    expect(toReadableClaudeError(message)).toBe(message);
  });

  it("falls back to the default message for empty input", () => {
    expect(toReadableClaudeError("")).toBe(DEFAULT_CLAUDE_ERROR_MESSAGE);
    expect(toReadableClaudeError("   ")).toBe(DEFAULT_CLAUDE_ERROR_MESSAGE);
  });

  it("maps network failures to a connectivity message", () => {
    expect(toReadableClaudeError("fetch failed: ENOTFOUND api.anthropic.com")).toContain(
      "connexion internet",
    );
  });

  it("maps auth failures to a reconnect message", () => {
    expect(toReadableClaudeError("Request failed with status 401 Unauthorized")).toContain(
      "reconnecte-toi",
    );
  });

  it("maps rate-limit failures to a usage-limit message", () => {
    expect(toReadableClaudeError("429 Too Many Requests")).toContain("limite d'utilisation");
  });

  it("maps overloaded/server errors to a retry message", () => {
    expect(toReadableClaudeError("Error 503: service unavailable (overloaded)")).toContain(
      "surchargé",
    );
  });

  it("maps context-window overflow to a new-task message", () => {
    expect(toReadableClaudeError("prompt is too long: maximum context length exceeded")).toContain(
      "nouvelle tâche",
    );
  });

  it("maps CLI start failures to a start message", () => {
    expect(toReadableClaudeError("Claude Code process exited with code 1")).toContain(
      "n'a pas pu démarrer",
    );
  });

  it("maps timeouts to a slow-response message", () => {
    expect(toReadableClaudeError("Provider timed out after 60000ms")).toContain("trop de temps");
  });

  it("never leaks a raw JavaScript stack fragment", () => {
    const readable = toReadableClaudeError(
      "TypeError: x.push is not a function\n  at foo (a.js:1)",
    );
    expect(readable).not.toContain("push");
    expect(readable).not.toContain(".js");
    expect(readable).toBe(DEFAULT_CLAUDE_ERROR_MESSAGE);
  });
});

describe("isClaudeAbortMessage", () => {
  it("detects user cancellations", () => {
    expect(isClaudeAbortMessage("Request was aborted")).toBe(true);
    expect(isClaudeAbortMessage("The operation was cancelled")).toBe(true);
    expect(isClaudeAbortMessage("stream interrupted by user")).toBe(true);
  });

  it("does not flag genuine failures as aborts", () => {
    expect(isClaudeAbortMessage("Cannot read properties of null")).toBe(false);
  });
});
