import { beforeEach, describe, expect, it } from "vitest";
import { showAppDialog, useAppDialogStore } from "./app-dialog-store";

const OK_ACTION = [{ id: "ok", label: "OK" }];

describe("app dialog store", () => {
  beforeEach(() => {
    useAppDialogStore.setState({ current: null, queue: [] });
  });

  it("shows one dialog at a time and swaps the next queued one in", async () => {
    const first = showAppDialog({ title: "First", actions: OK_ACTION });
    const second = showAppDialog({ title: "Second", actions: OK_ACTION });

    expect(useAppDialogStore.getState().current?.title).toBe("First");
    expect(useAppDialogStore.getState().queue).toHaveLength(1);

    const firstKey = useAppDialogStore.getState().current?.key ?? "";
    useAppDialogStore.getState().resolve(firstKey, "ok");
    await expect(first).resolves.toBe("ok");

    expect(useAppDialogStore.getState().current?.title).toBe("Second");
    expect(useAppDialogStore.getState().queue).toHaveLength(0);

    const secondKey = useAppDialogStore.getState().current?.key ?? "";
    useAppDialogStore.getState().resolve(secondKey, null);
    await expect(second).resolves.toBeNull();
    expect(useAppDialogStore.getState().current).toBeNull();
  });

  it("ignores a second resolve for the same dialog", async () => {
    const pending = showAppDialog({ title: "Only", actions: OK_ACTION });
    const key = useAppDialogStore.getState().current?.key ?? "";

    useAppDialogStore.getState().resolve(key, "ok");
    useAppDialogStore.getState().resolve(key, null);

    await expect(pending).resolves.toBe("ok");
    expect(useAppDialogStore.getState().current).toBeNull();
  });
});
