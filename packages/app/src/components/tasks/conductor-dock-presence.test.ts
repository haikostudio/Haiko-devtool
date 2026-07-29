import { describe, expect, it } from "vitest";
import { resolveConductorDockPresence } from "./conductor-dock-presence";

describe("resolveConductorDockPresence", () => {
  it("shows the conductor, focused, when nothing covers the dock", () => {
    expect(
      resolveConductorDockPresence({
        hasDockedTask: false,
        hasDeployAgent: false,
        conductorResolved: true,
      }),
    ).toEqual({
      showTaskView: false,
      showDeployView: false,
      conductorVisible: true,
      conductorFocused: true,
      ensureSuspended: false,
    });
  });

  it("hides the conductor behind a docked task without ever suspending it", () => {
    // The regression this file exists for: docking a task must not tear the
    // conductor down, or an in-flight turn disappears from the panel.
    const presence = resolveConductorDockPresence({
      hasDockedTask: true,
      hasDeployAgent: false,
      conductorResolved: true,
    });
    expect(presence.showTaskView).toBe(true);
    expect(presence.conductorVisible).toBe(false);
    expect(presence.conductorFocused).toBe(false);
    expect(presence.ensureSuspended).toBe(false);
  });

  it("hides the conductor behind the deploy agent the same way, without suspending it", () => {
    const presence = resolveConductorDockPresence({
      hasDockedTask: false,
      hasDeployAgent: true,
      conductorResolved: true,
    });
    expect(presence.showDeployView).toBe(true);
    expect(presence.showTaskView).toBe(false);
    expect(presence.conductorVisible).toBe(false);
    expect(presence.conductorFocused).toBe(false);
    expect(presence.ensureSuspended).toBe(false);
  });

  it("suspends the ensure only when the dock is covered before any conductor exists", () => {
    expect(
      resolveConductorDockPresence({
        hasDockedTask: true,
        hasDeployAgent: false,
        conductorResolved: false,
      }).ensureSuspended,
    ).toBe(true);
    expect(
      resolveConductorDockPresence({
        hasDockedTask: false,
        hasDeployAgent: true,
        conductorResolved: false,
      }).ensureSuspended,
    ).toBe(true);
  });

  it("keeps the ensure live on the conductor view even before one is resolved", () => {
    expect(
      resolveConductorDockPresence({
        hasDockedTask: false,
        hasDeployAgent: false,
        conductorResolved: false,
      }).ensureSuspended,
    ).toBe(false);
  });

  it("does not flip the ensure gate when a task is opened and closed again", () => {
    const resolved = { hasDeployAgent: false, conductorResolved: true };
    const before = resolveConductorDockPresence({ hasDockedTask: false, ...resolved });
    const during = resolveConductorDockPresence({ hasDockedTask: true, ...resolved });
    const after = resolveConductorDockPresence({ hasDockedTask: false, ...resolved });
    expect(before.ensureSuspended).toBe(false);
    expect(during.ensureSuspended).toBe(false);
    expect(after.ensureSuspended).toBe(false);
  });
});
