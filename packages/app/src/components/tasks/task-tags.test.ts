import { describe, expect, it } from "vitest";
import { daysUntil, parseDeadlineDate, parseTaskTags } from "./task-tags";

describe("parseTaskTags", () => {
  it("pulls priority and deadline out of the flat tag list", () => {
    const parsed = parseTaskTags(["priorité-haute", "échéance-15.07.26", "HEXAPRO", "i18n"]);
    expect(parsed.priority).toEqual({ level: "high", label: "haute" });
    expect(parsed.deadline?.label).toBe("15.07.26");
    expect(parsed.deadline?.dueDate).toEqual(new Date(2026, 6, 15));
    expect(parsed.tags).toEqual(["HEXAPRO", "i18n"]);
  });

  it("maps priority suffixes to levels", () => {
    expect(parseTaskTags(["priorité-haute"]).priority?.level).toBe("high");
    expect(parseTaskTags(["priorité-moyenne"]).priority?.level).toBe("medium");
    expect(parseTaskTags(["priorité-basse"]).priority?.level).toBe("low");
    expect(parseTaskTags(["priority-high"]).priority?.level).toBe("high");
    expect(parseTaskTags(["priorité-inconnue"]).priority?.level).toBe("other");
  });

  it("keeps a non-date deadline as a humanized label with no date", () => {
    const parsed = parseTaskTags(["échéance-à-définir"]);
    expect(parsed.deadline).toEqual({ label: "à définir", dueDate: null });
  });

  it("only lifts the first priority and first deadline; the rest stay tags", () => {
    const parsed = parseTaskTags([
      "priorité-haute",
      "priorité-basse",
      "échéance-15.07.26",
      "échéance-31.12.26",
    ]);
    expect(parsed.priority?.label).toBe("haute");
    expect(parsed.deadline?.label).toBe("15.07.26");
    expect(parsed.tags).toEqual(["priorité-basse", "échéance-31.12.26"]);
  });

  it("leaves ordinary tags untouched", () => {
    const parsed = parseTaskTags(["bug", "notifications"]);
    expect(parsed.priority).toBeNull();
    expect(parsed.deadline).toBeNull();
    expect(parsed.tags).toEqual(["bug", "notifications"]);
  });
});

describe("parseDeadlineDate", () => {
  it("accepts dd.mm.yy, dd/mm/yyyy and dashes", () => {
    expect(parseDeadlineDate("15.07.26")).toEqual(new Date(2026, 6, 15));
    expect(parseDeadlineDate("31/12/2026")).toEqual(new Date(2026, 11, 31));
    expect(parseDeadlineDate("1-2-27")).toEqual(new Date(2027, 1, 1));
  });

  it("rejects impossible and non-date values", () => {
    expect(parseDeadlineDate("31.02.26")).toBeNull();
    expect(parseDeadlineDate("à définir")).toBeNull();
    expect(parseDeadlineDate("13.13.26")).toBeNull();
  });
});

describe("daysUntil", () => {
  it("counts whole days regardless of time of day", () => {
    const from = new Date(2026, 6, 15, 23, 0, 0);
    expect(daysUntil(new Date(2026, 6, 18, 1, 0, 0), from)).toBe(3);
    expect(daysUntil(new Date(2026, 6, 15, 0, 0, 0), from)).toBe(0);
    expect(daysUntil(new Date(2026, 6, 12, 0, 0, 0), from)).toBe(-3);
  });
});
