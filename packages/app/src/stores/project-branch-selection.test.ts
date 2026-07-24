import { describe, expect, it } from "vitest";
import {
  createProjectBranchSelectionStore,
  type ProjectBranchSelection,
  type ProjectBranchSelectionStorage,
} from "./project-branch-selection";

class MemoryStorage implements ProjectBranchSelectionStorage {
  saved: string | null = null;
  constructor(initial: string | null = null) {
    this.saved = initial;
  }
  read(): Promise<string | null> {
    return Promise.resolve(this.saved);
  }
  async write(value: string): Promise<void> {
    this.saved = value;
  }
  savedEntries(): ProjectBranchSelection[] {
    return this.saved ? (JSON.parse(this.saved) as ProjectBranchSelection[]) : [];
  }
}

class DelayedStorage implements ProjectBranchSelectionStorage {
  private finishRead: (value: string | null) => void = () => {};
  private readonly pendingRead = new Promise<string | null>((resolve) => {
    this.finishRead = resolve;
  });
  saved: string | null = null;
  read(): Promise<string | null> {
    return this.pendingRead;
  }
  async write(value: string): Promise<void> {
    this.saved = value;
  }
  finishWith(entries: ProjectBranchSelection[]) {
    this.finishRead(JSON.stringify(entries));
  }
}

describe("project branch selection", () => {
  it("remembers a branch per project and persists it", async () => {
    const storage = new MemoryStorage();
    const store = createProjectBranchSelectionStore(storage);

    store.remember({ serverId: "s1", projectId: "p1", branch: "feature/a" });
    store.remember({ serverId: "s1", projectId: "p2", branch: "feature/b" });

    expect(store.getBranch("s1", "p1")).toBe("feature/a");
    expect(store.getBranch("s1", "p2")).toBe("feature/b");
    expect(store.getBranch("s1", "missing")).toBeNull();
    // Persisted so a later store instance can hydrate it.
    expect(storage.savedEntries()).toHaveLength(2);
  });

  it("keeps distinct branches for the same project id on different servers", () => {
    const store = createProjectBranchSelectionStore(new MemoryStorage());
    store.remember({ serverId: "s1", projectId: "p1", branch: "main" });
    store.remember({ serverId: "s2", projectId: "p1", branch: "dev" });
    expect(store.getBranch("s1", "p1")).toBe("main");
    expect(store.getBranch("s2", "p1")).toBe("dev");
  });

  it("hydrates saved branches from storage", async () => {
    const storage = new MemoryStorage(
      JSON.stringify([{ serverId: "s1", projectId: "p1", branch: "feature/a" }]),
    );
    const store = createProjectBranchSelectionStore(storage);
    await store.hydrate();
    expect(store.getBranch("s1", "p1")).toBe("feature/a");
    expect(store.isHydrated()).toBe(true);
  });

  it("keeps a branch remembered during a slow hydration", async () => {
    const storage = new DelayedStorage();
    const store = createProjectBranchSelectionStore(storage);
    const hydration = store.hydrate();

    store.remember({ serverId: "s1", projectId: "p1", branch: "fresh" });
    storage.finishWith([{ serverId: "s1", projectId: "p1", branch: "stale" }]);
    await hydration;

    expect(store.getBranch("s1", "p1")).toBe("fresh");
  });

  it("merges stored branches for untouched projects on hydration", async () => {
    const storage = new DelayedStorage();
    const store = createProjectBranchSelectionStore(storage);
    const hydration = store.hydrate();

    store.remember({ serverId: "s1", projectId: "p1", branch: "fresh" });
    storage.finishWith([
      { serverId: "s1", projectId: "p1", branch: "stale" },
      { serverId: "s1", projectId: "p2", branch: "restored" },
    ]);
    await hydration;

    expect(store.getBranch("s1", "p1")).toBe("fresh");
    expect(store.getBranch("s1", "p2")).toBe("restored");
  });

  it("ignores malformed entries", () => {
    const store = createProjectBranchSelectionStore(
      new MemoryStorage(JSON.stringify([{ serverId: "s1" }, "nope", 42])),
    );
    expect(store.getBranch("s1", "p1")).toBeNull();
  });

  it("forgets a remembered branch", () => {
    const store = createProjectBranchSelectionStore(new MemoryStorage());
    store.remember({ serverId: "s1", projectId: "p1", branch: "feature/a" });
    store.forget("s1", "p1");
    expect(store.getBranch("s1", "p1")).toBeNull();
  });

  it("notifies subscribers when a branch changes", () => {
    const store = createProjectBranchSelectionStore(new MemoryStorage());
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.remember({ serverId: "s1", projectId: "p1", branch: "feature/a" });
    // Same value should not notify again.
    store.remember({ serverId: "s1", projectId: "p1", branch: "feature/a" });
    store.remember({ serverId: "s1", projectId: "p1", branch: "feature/b" });
    unsubscribe();
    store.remember({ serverId: "s1", projectId: "p1", branch: "feature/c" });
    expect(calls).toBe(2);
  });
});
