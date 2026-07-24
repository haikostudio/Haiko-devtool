import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RecentFactsStore } from "./recent-facts.js";

const logger = pino({ level: "silent" });

describe("RecentFactsStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-recent-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("stores and reloads fresh facts, newest first", async () => {
    const store = new RecentFactsStore(dir, logger);
    await store.add("Paseo", ["fait A"]);
    await store.add("Paseo", ["fait B"]);
    expect(await store.load("Paseo")).toEqual(["fait B", "fait A"]);
  });

  test("dedupes by folded text (accents/case-insensitive)", async () => {
    const store = new RecentFactsStore(dir, logger);
    await store.add("Paseo", ["Le Bandeau"]);
    await store.add("Paseo", ["autre"]);
    await store.add("Paseo", ["le bandeau"]);
    const facts = await store.load("Paseo");
    // "Le Bandeau" and "le bandeau" collapse to a single entry.
    expect(facts).toHaveLength(2);
    expect(facts.filter((f) => f.toLowerCase().includes("bandeau"))).toHaveLength(1);
    expect(facts).toContain("autre");
  });

  test("drops facts past the freshness window", async () => {
    let clock = 1_000;
    const store = new RecentFactsStore(dir, logger, { freshnessMs: 100, now: () => clock });
    await store.add("Paseo", ["fait"]);
    clock = 1_050; // within window
    expect(await store.load("Paseo")).toEqual(["fait"]);
    clock = 1_200; // past the 100 ms window
    expect(await store.load("Paseo")).toEqual([]);
  });

  test("isolates facts per project", async () => {
    const store = new RecentFactsStore(dir, logger);
    await store.add("Paseo", ["fait paseo"]);
    await store.add("Eloya", ["fait eloya"]);
    expect(await store.load("Paseo")).toEqual(["fait paseo"]);
    expect(await store.load("Eloya")).toEqual(["fait eloya"]);
  });

  test("empty facts are a no-op, missing project loads empty", async () => {
    const store = new RecentFactsStore(dir, logger);
    await store.add("Paseo", ["  ", ""]);
    expect(await store.load("Paseo")).toEqual([]);
    expect(await store.load("Inconnu")).toEqual([]);
  });
});
