import { describe, expect, it } from "vitest";
import { resolveConductorDockPresence } from "./conductor-dock-presence";

describe("resolveConductorDockPresence", () => {
  it("shows the conductor, focused, when no task is docked", () => {
    expect(resolveConductorDockPresence({ hasDockedTask: false, conductorResolved: true })).toEqual(
      {
        showTaskView: false,
        conductorVisible: true,
        conductorFocused: true,
        ensureSuspended: false,
      },
    );
  });

  it("hides the conductor behind a docked task without ever suspending it", () => {
    // The regression this file exists for: docking a task must not tear the
    // conductor down, or an in-flight turn disappears from the panel.
    const presence = resolveConductorDockPresence({
      hasDockedTask: true,
      conductorResolved: true,
    });
    expect(presence.showTaskView).toBe(true);
    expect(presence.conductorVisible).toBe(false);
    expect(presence.conductorFocused).toBe(false);
    expect(presence.ensureSuspended).toBe(false);
  });

  it("suspends the ensure only for a task docked before any conductor exists", () => {
    expect(
      resolveConductorDockPresence({ hasDockedTask: true, conductorResolved: false })
        .ensureSuspended,
    ).toBe(true);
  });

  it("keeps the ensure live on the conductor view even before one is resolved", () => {
    expect(
      resolveConductorDockPresence({ hasDockedTask: false, conductorResolved: false })
        .ensureSuspended,
    ).toBe(false);
  });

  it("does not flip the ensure gate when a task is opened and closed again", () => {
    const resolved = { conductorResolved: true };
    const before = resolveConductorDockPresence({ hasDockedTask: false, ...resolved });
    const during = resolveConductorDockPresence({ hasDockedTask: true, ...resolved });
    const after = resolveConductorDockPresence({ hasDockedTask: false, ...resolved });
    expect(before.ensureSuspended).toBe(false);
    expect(during.ensureSuspended).toBe(false);
    expect(after.ensureSuspended).toBe(false);
  });
});
