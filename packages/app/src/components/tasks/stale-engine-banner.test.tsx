/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "tasks.board.staleEngineTitle": "Mettre à jour la version du moteur",
        "tasks.board.staleEngineAction": "Mettre à jour",
        "tasks.board.staleEngineUpdating": "Mise à jour…",
      })[key] ?? key,
  }),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    title,
    children,
    testID,
  }: {
    title: string;
    children: React.ReactNode;
    testID: string;
  }) => (
    <section data-testid={testID}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onPress: () => void;
    testID: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

import { StaleEngineBanner } from "./stale-engine-banner";

const technicalFreshness = {
  builtSha: "technical-built-id",
  deployedSha: "technical-deployed-id",
};
const staleFreshness = { builtSha: "built", deployedSha: "deployed" };

describe("StaleEngineBanner", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows one simple action without technical versions", () => {
    const onUpdate = vi.fn();
    act(() => {
      root.render(
        <StaleEngineBanner
          freshness={technicalFreshness}
          onUpdate={onUpdate}
          progressLabel={null}
        />,
      );
    });

    expect(container.textContent).toBe("Mettre à jour la version du moteurMettre à jour");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.textContent).not.toContain("technical-built-id");
    expect(container.textContent).not.toContain("technical-deployed-id");

    container.querySelector("button")?.click();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows detailed progress and disables the action while it runs", () => {
    const onUpdate = vi.fn();
    act(() => {
      root.render(
        <StaleEngineBanner
          freshness={staleFreshness}
          onUpdate={onUpdate}
          progressLabel="Construction de l'application…"
        />,
      );
    });

    const button = container.querySelector("button");
    button?.click();

    expect(onUpdate).not.toHaveBeenCalled();
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Construction de l'application…");
  });
});
