/**
 * Which terminals an agent opened for itself.
 *
 * A terminal knows its cwd and its workspace, never who asked for it — and a
 * task card runs in the project's main checkout alongside everything else, so
 * "the terminals of this workspace" is far too wide a net to close a card's
 * terminals with. The only reliable link is the gesture itself: the agent called
 * `create_terminal`, so that call is where the owner is recorded.
 *
 * Deliberately in-memory and daemon-local. Terminals do not survive a daemon
 * restart either, so a mapping that outlived one would only ever point at
 * terminals that no longer exist.
 */
export class AgentTerminalRegistry {
  private readonly terminalIdsByAgentId = new Map<string, Set<string>>();

  /** Records that `agentId` opened `terminalId`. */
  record(agentId: string, terminalId: string): void {
    const agent = agentId.trim();
    const terminal = terminalId.trim();
    if (!agent || !terminal) {
      return;
    }
    let terminals = this.terminalIdsByAgentId.get(agent);
    if (!terminals) {
      terminals = new Set();
      this.terminalIdsByAgentId.set(agent, terminals);
    }
    terminals.add(terminal);
  }

  /**
   * The terminals `agentId` opened, and forgets them: an agent's terminals are
   * claimed once, by whoever closes that agent down.
   */
  takeForAgent(agentId: string): string[] {
    const terminals = this.terminalIdsByAgentId.get(agentId);
    if (!terminals) {
      return [];
    }
    this.terminalIdsByAgentId.delete(agentId);
    return [...terminals];
  }

  /** Drops a terminal that died on its own. */
  forget(terminalId: string): void {
    for (const [agentId, terminals] of this.terminalIdsByAgentId) {
      if (terminals.delete(terminalId) && terminals.size === 0) {
        this.terminalIdsByAgentId.delete(agentId);
      }
    }
  }
}
