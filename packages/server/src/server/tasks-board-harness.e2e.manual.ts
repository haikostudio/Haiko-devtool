/**
 * Ad-hoc daemon harness for the tasks board RPC surface (docs/ad-hoc-daemon-testing.md).
 * Run with: npx tsx packages/server/src/server/tasks-board-harness.e2e.manual.ts
 *
 * Exercises: server_info tasksBoard flag, folder CRUD, task create/move/update,
 * board subscription pushes. Deliberately avoids the "scheduled" column so the
 * estimator never launches a real agent.
 */
import assert from "node:assert/strict";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const daemon = await createTestPaseoDaemon();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.1.108",
});

try {
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "harness" } });

  const projectId = "harness-project";
  const pushes: unknown[] = [];
  client.on("tasks.board.update", (message) => {
    pushes.push(message.payload.board);
  });

  const subscribed = await client.tasksBoardSubscribe(projectId, "sub-harness");
  assert.equal(subscribed.error, null);
  assert.equal(subscribed.board?.folders.length, 0);
  console.log("✓ subscribe returns empty board snapshot");

  const folder = await client.tasksFolderCreate({ projectId, name: "Auth" });
  assert.equal(folder.error, null);
  assert.ok(folder.folder?.id);
  console.log("✓ folder created:", folder.folder?.id);

  const created = await client.tasksTaskCreate({
    projectId,
    folderId: folder.folder!.id,
    title: "Implement login flow",
    tags: ["auth", "ui"],
  });
  assert.equal(created.error, null);
  assert.equal(created.task?.column, "backlog");
  console.log("✓ task created in backlog:", created.task?.id);

  const moved = await client.tasksTaskMove({
    projectId,
    taskId: created.task!.id,
    column: "in_progress",
    index: 0,
  });
  assert.equal(moved.error, null);
  const movedTask = moved.board?.tasks.find((task) => task.id === created.task!.id);
  assert.equal(movedTask?.column, "in_progress");
  assert.ok(movedTask?.manualOverrideAt);
  console.log("✓ task moved to in_progress with manual override stamp");

  const updated = await client.tasksTaskUpdate({
    projectId,
    taskId: created.task!.id,
    description: "Cover email + OAuth",
  });
  assert.equal(updated.task?.description, "Cover email + OAuth");
  console.log("✓ task updated");

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(pushes.length >= 3, `expected board pushes, got ${pushes.length}`);
  console.log(`✓ received ${pushes.length} board update pushes`);

  const fresh = await client.tasksBoardGet(projectId);
  assert.equal(fresh.board?.tasks.length, 1);
  assert.equal(fresh.board?.folders.length, 1);
  console.log("✓ board.get returns persisted state");

  await client.tasksTaskDelete({ projectId, taskId: created.task!.id });
  await client.tasksFolderDelete({ projectId, folderId: folder.folder!.id });
  const emptied = await client.tasksBoardGet(projectId);
  assert.equal(emptied.board?.tasks.length, 0);
  assert.equal(emptied.board?.folders.length, 0);
  console.log("✓ delete task + folder");

  await client.tasksBoardUnsubscribe("sub-harness");
  console.log("\nAll tasks-board harness checks passed.");
} finally {
  await client.close();
  await daemon.close();
}
