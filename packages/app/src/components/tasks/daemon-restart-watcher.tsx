import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDaemonRestartStore, type InterruptedAgent } from "@/stores/daemon-restart-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { buildRestartResumePrompt } from "@/components/tasks/restart-resume-prompt";
import { RESTART_ARMING_MS, RESTART_TIMEOUT_MS } from "@/components/tasks/daemon-restart-progress";

/** The countdown only needs to redraw once a second. */
const TICK_MS = 250;

interface RestartClient {
  restartServer: (reason?: string) => Promise<unknown>;
  sendMessage: (agentId: string, text: string) => Promise<void>;
}

/**
 * Renders nothing; owns everything that must happen exactly once for a daemon
 * restart. Mounted a single time at the app root — putting these effects in the
 * shared hook would give every mounted reader its own timer and its own
 * "moteur redémarré" toast, and mounting it on one screen would strand a
 * restart started from another.
 *
 * Four jobs, in order:
 *  - tick the clock the bar reads, but only while a restart is in flight;
 *  - send the request once the undo window closes (that delay IS the feature);
 *  - settle the restart when the connection drops and comes back — or give up,
 *    loudly, if it never does;
 *  - hand every agent the restart cut short a resume instruction, so a turn
 *    interrupted mid-flight is picked back up instead of silently lost.
 */
export function DaemonRestartWatcher({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId ?? "") as RestartClient | null;
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const armedAtMs = useDaemonRestartStore((state) => state.armedAtMs);
  const startedAtMs = useDaemonRestartStore((state) => state.startedAtMs);
  const nowMs = useDaemonRestartStore((state) => state.nowMs);
  const sawDisconnect = useDaemonRestartStore((state) => state.sawDisconnect);
  const tick = useDaemonRestartStore((state) => state.tick);
  const begin = useDaemonRestartStore((state) => state.begin);
  const markDisconnected = useDaemonRestartStore((state) => state.markDisconnected);
  const markReconnected = useDaemonRestartStore((state) => state.markReconnected);
  const clear = useDaemonRestartStore((state) => state.clear);
  // Guards the one-shot transitions against a re-render landing between two
  // store updates (an effect that fires twice must not send two requests).
  const firedRef = useRef(false);

  // Drive the clock, and stop the moment it is over — an interval ticking on an
  // idle app is pure waste.
  useEffect(() => {
    if (armedAtMs === null && startedAtMs === null) {
      return;
    }
    tick(Date.now());
    const timer = setInterval(() => tick(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [armedAtMs, startedAtMs, tick]);

  // The undo window closed: send the request for real.
  useEffect(() => {
    if (armedAtMs === null || startedAtMs !== null) {
      firedRef.current = false;
      return;
    }
    if (nowMs - armedAtMs < RESTART_ARMING_MS || firedRef.current || !client) {
      return;
    }
    firedRef.current = true;
    begin(Date.now());
    void client.restartServer("tasks_card_daemon_restart").catch((error) => {
      // The socket dropping mid-restart is the SUCCESS path, not a failure: the
      // daemon exits before it can answer. Only a refusal that left us connected
      // is a real error — the timeout below catches anything else.
      if (!useDaemonRestartStore.getState().sawDisconnect) {
        clear();
        toast.error(error instanceof Error ? error.message : String(error));
      }
    });
  }, [armedAtMs, startedAtMs, nowMs, client, begin, clear, toast]);

  // Down, then up again = the daemon is back.
  useEffect(() => {
    if (startedAtMs === null) {
      return;
    }
    if (!connected) {
      markDisconnected();
      return;
    }
    if (!sawDisconnect) {
      return;
    }
    // Read before clearing: settling the restart wipes the list.
    const interrupted = useDaemonRestartStore.getState().interrupted;
    markReconnected();
    clear();
    toast.show(t("tasks.panel.restartDaemonDone"));
    if (interrupted.length > 0 && client) {
      resumeInterruptedAgents(client, interrupted, () => {
        toast.show(t("tasks.panel.restartResumed", { count: interrupted.length }));
      });
    }
  }, [
    connected,
    startedAtMs,
    sawDisconnect,
    client,
    markDisconnected,
    markReconnected,
    clear,
    toast,
    t,
  ]);

  // A daemon that never came back: say so and free the bar, rather than
  // counting into the void.
  useEffect(() => {
    if (startedAtMs === null || nowMs - startedAtMs < RESTART_TIMEOUT_MS) {
      return;
    }
    clear();
    toast.error(t("tasks.panel.restartDaemonTimeout"));
  }, [nowMs, startedAtMs, clear, toast, t]);

  return null;
}

/**
 * Hands each interrupted agent its resume instruction. Failures are swallowed
 * per agent: an agent that has since been archived must not stop the others from
 * picking their work back up.
 */
function resumeInterruptedAgents(
  client: RestartClient,
  interrupted: InterruptedAgent[],
  onDone: () => void,
): void {
  void Promise.allSettled(
    interrupted.map((agent) => client.sendMessage(agent.agentId, buildRestartResumePrompt(agent))),
  ).then(onDone);
}
