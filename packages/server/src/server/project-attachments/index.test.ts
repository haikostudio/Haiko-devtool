import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectAttachmentLibrary, getProjectAttachmentLibrary } from "./index.js";

describe("ProjectAttachmentLibrary", () => {
  let home: string;
  let library: ProjectAttachmentLibrary;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-attachments-"));
    library = new ProjectAttachmentLibrary(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns an empty list for a project with no attachments", async () => {
    expect(await library.list("prj_missing")).toEqual([]);
  });

  it("records and lists attachments most-recent first", async () => {
    await library.record("prj_1", {
      id: "a",
      fileName: "old.pdf",
      mimeType: "application/pdf",
      size: 10,
      addedAt: "2026-01-01T00:00:00.000Z",
      source: "upload",
    });
    await library.record("prj_1", {
      id: "b",
      fileName: "new.png",
      mimeType: "image/png",
      size: 20,
      addedAt: "2026-02-01T00:00:00.000Z",
      source: "image",
    });

    const list = await library.list("prj_1");
    expect(list.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(list[0]?.agentId).toBeNull();
  });

  it("deduplicates by id", async () => {
    const input = {
      id: "dup",
      fileName: "doc.pdf",
      mimeType: "application/pdf",
      size: 5,
      addedAt: "2026-01-01T00:00:00.000Z",
      source: "upload",
    };
    await library.record("prj_1", input);
    await library.record("prj_1", input);

    expect(await library.list("prj_1")).toHaveLength(1);
  });

  it("isolates attachments per project", async () => {
    await library.record("prj_1", {
      id: "a",
      fileName: "a.pdf",
      mimeType: "application/pdf",
      size: 1,
      addedAt: "2026-01-01T00:00:00.000Z",
      source: "upload",
    });

    expect(await library.list("prj_2")).toEqual([]);
  });

  it("returns a shared instance per home", () => {
    expect(getProjectAttachmentLibrary(home)).toBe(getProjectAttachmentLibrary(home));
  });
});
