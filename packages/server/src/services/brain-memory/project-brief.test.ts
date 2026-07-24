import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProjectBriefStore, projectBriefSlug } from "./project-brief.js";

const logger = pino({ level: "silent" });

describe("projectBriefSlug", () => {
  test.each([
    ["Paseo", "paseo"],
    ["Éloya SaaS", "eloya-saas"],
    ["mon projet (v2)", "mon-projet-v2"],
    ["///", "projet"],
  ])("%s → %s", (input, expected) => {
    expect(projectBriefSlug(input)).toBe(expected);
  });
});

describe("ProjectBriefStore", () => {
  let dir: string;
  let store: ProjectBriefStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-brief-"));
    store = new ProjectBriefStore(dir, logger);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("load returns null when no fiche exists", async () => {
    expect(await store.load("Paseo")).toBeNull();
  });

  test("save then load roundtrips, accent-insensitive on the project name", async () => {
    await store.save("Éloya SaaS", "# Fiche\nProjet de facturation.");
    expect(await store.load("eloya saas")).toBe("# Fiche\nProjet de facturation.");
  });

  test("save overwrites the previous fiche", async () => {
    await store.save("Paseo", "v1");
    await store.save("Paseo", "v2");
    expect(await store.load("Paseo")).toBe("v2");
  });

  test("empty content is ignored and keeps the existing fiche", async () => {
    await store.save("Paseo", "contenu");
    await store.save("Paseo", "   \n  ");
    expect(await store.load("Paseo")).toBe("contenu");
  });

  test("oversized content is bounded", async () => {
    await store.save("Paseo", "x".repeat(20_000));
    const loaded = await store.load("Paseo");
    expect(loaded).not.toBeNull();
    expect((loaded ?? "").length).toBeLessThanOrEqual(6_000);
  });
});
