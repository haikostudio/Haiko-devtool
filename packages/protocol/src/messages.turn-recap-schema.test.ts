import { describe, expect, it } from "vitest";

import { AgentTimelineItemPayloadSchema } from "./messages.js";

describe("turn_recap timeline item schema", () => {
  it("parses a full recap with files and highlights", () => {
    const parsed = AgentTimelineItemPayloadSchema.parse({
      type: "turn_recap",
      summary: "J'ai ajouté un bloc récapitulatif à la fin de chaque tour.",
      highlights: ["Nouveau bloc en langage simple", "Liste des fichiers modifiés cliquable"],
      files: [
        { path: "packages/app/src/components/turn-recap-card.tsx", operation: "created" },
        { path: "packages/server/src/server/session.ts", operation: "edited" },
      ],
      cwd: "/root/paseo",
    });
    expect(parsed).toMatchObject({
      type: "turn_recap",
      files: [
        { path: "packages/app/src/components/turn-recap-card.tsx", operation: "created" },
        { path: "packages/server/src/server/session.ts", operation: "edited" },
      ],
    });
  });

  it("parses a minimal recap (highlights and cwd optional — back-compat)", () => {
    const parsed = AgentTimelineItemPayloadSchema.parse({
      type: "turn_recap",
      summary: "Fichier corrigé.",
      files: [{ path: "a.ts", operation: "deleted" }],
    });
    expect(parsed).toMatchObject({ type: "turn_recap", summary: "Fichier corrigé." });
  });

  it("rejects an unknown file operation", () => {
    const result = AgentTimelineItemPayloadSchema.safeParse({
      type: "turn_recap",
      summary: "x",
      files: [{ path: "a.ts", operation: "renamed" }],
    });
    expect(result.success).toBe(false);
  });
});
