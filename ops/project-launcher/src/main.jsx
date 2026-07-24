import React from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ExternalLink,
  FileText,
  Loader2,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Server,
  SquareTerminal,
  X,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const initialToken = params.get("key") || window.localStorage.getItem("projectLauncherKey") || "";
if (initialToken) window.localStorage.setItem("projectLauncherKey", initialToken);

function statusTone(project) {
  if (project.activeState === "active") return "success";
  if (project.activeState === "activating") return "warning";
  if (project.activeState === "failed") return "destructive";
  return "outline";
}

function statusLabel(project) {
  if (project.activeState === "active") return "running";
  if (project.activeState === "activating") return "starting";
  if (project.activeState === "failed") return "failed";
  return "stopped";
}

function isRunning(project) {
  return project?.activeState === "active" || project?.activeState === "activating";
}

function openProjectUrl(project) {
  const url = project?.hostUrl || project?.pathUrl;
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function now() {
  return new Date().toLocaleTimeString("fr-FR", { hour12: false });
}

function commandBlock(payload) {
  const config = payload.config
    ? [
        `$ ${payload.config.command}`,
        payload.config.ran ? "Config executee." : "Config deja valide, reutilisation.",
        payload.config.stdout || "",
        payload.config.stderr || "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return [
    config,
    payload.command ? `$ ${payload.command}` : "",
    payload.stdout || "",
    payload.stderr || "",
    payload.logs || payload.output || "",
  ]
    .filter(Boolean)
    .join("\n");
}

function ProjectTerminal({ project, token, onClose }) {
  const containerRef = React.useRef(null);
  const terminalRef = React.useRef(null);
  const fitRef = React.useRef(null);
  const socketRef = React.useRef(null);
  const shouldTerminateOnCloseRef = React.useRef(false);

  React.useEffect(() => {
    if (!project || !containerRef.current) return undefined;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: "#07090d",
        foreground: "#d7fbe8",
        cursor: "#7dd3fc",
        selectionBackground: "#26435a",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();
    terminal.focus();

    terminalRef.current = terminal;
    fitRef.current = fit;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({
      slug: project.slug,
      key: token,
      cols: String(terminal.cols),
      rows: String(terminal.rows),
    });
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/project-launcher/terminal?${query.toString()}`,
    );
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      terminal.writeln(`[Project Launcher] Terminal attache pour ${project.slug}`);
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "data" || payload.type === "exit" || payload.type === "error") {
        terminal.write(payload.data);
      }
    });

    socket.addEventListener("close", () => {
      terminal.writeln("\r\n[Project Launcher] Session fermee");
    });

    const disposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const sendSize = () => {
      try {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        }
      } catch {}
    };
    const observer = new ResizeObserver(sendSize);
    observer.observe(containerRef.current);
    window.setTimeout(sendSize, 100);

    return () => {
      observer.disconnect();
      disposable.dispose();
      if (shouldTerminateOnCloseRef.current && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "terminate" }));
      }
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
    };
  }, [project?.slug, token]);

  const handleClose = React.useCallback(() => {
    shouldTerminateOnCloseRef.current = true;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "terminate" }));
    }
    window.setTimeout(onClose, 100);
  }, [onClose]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-terminal">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-panel px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">Terminal · {project?.slug}</div>
          <div className="truncate text-xs text-muted-foreground">{project?.workingDirectory}</div>
        </div>
        <Button variant="outline" size="icon" onClick={handleClose} aria-label="Fermer le terminal">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 p-2" />
    </div>
  );
}

function App() {
  const [token, setToken] = React.useState(initialToken);
  const [projects, setProjects] = React.useState([]);
  const [selectedSlug, setSelectedSlug] = React.useState("");
  const [terminal, setTerminal] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [busySlug, setBusySlug] = React.useState("");
  const [terminalSlugs, setTerminalSlugs] = React.useState(() => new Set());
  const [activeWorkspaceTab, setActiveWorkspaceTab] = React.useState("run");
  const selected = projects.find((project) => project.slug === selectedSlug) || projects[0] || null;
  const activeTerminalSlug = activeWorkspaceTab.startsWith("terminal:")
    ? activeWorkspaceTab.slice("terminal:".length)
    : "";
  const terminalProjects = React.useMemo(
    () =>
      Array.from(terminalSlugs)
        .map((slug) => projects.find((project) => project.slug === slug))
        .filter(Boolean),
    [projects, terminalSlugs],
  );
  const debugProject =
    terminalProjects.find((project) => project.slug === activeTerminalSlug) || null;

  const api = React.useCallback(
    async (path, options = {}) => {
      const response = await fetch(`/project-launcher/api${path}`, {
        ...options,
        headers: {
          "x-launcher-token": token,
          ...(options.headers || {}),
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      return payload;
    },
    [token],
  );

  const appendTerminal = React.useCallback((text) => {
    setTerminal((current) => `${current}${current ? "\n" : ""}[${now()}] ${text}`);
  }, []);

  const refresh = React.useCallback(
    async ({ quiet = false } = {}) => {
      if (!token) return;
      if (!quiet) setLoading(true);
      try {
        const payload = await api("/projects");
        setProjects(payload.projects);
        setSelectedSlug((current) => current || payload.projects[0]?.slug || "");
      } catch (error) {
        appendTerminal(`ERROR: ${error.message}`);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [api, appendTerminal, token],
  );

  React.useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh({ quiet: true }), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  React.useEffect(() => {
    if (!selected || terminal) return;
    setTerminal(
      [
        `$ ${selected.unit}`,
        `WorkingDirectory: ${selected.workingDirectory}`,
        selected.runScript ? `RunScript: ${selected.runScript}` : "",
        `Port: ${selected.port}`,
        `URL: ${selected.hostUrl || selected.pathUrl}`,
        `Status: ${statusLabel(selected)} / ${selected.subState}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }, [selected, terminal]);

  React.useEffect(() => {
    if (activeWorkspaceTab === "run") return;
    if (debugProject) return;
    setActiveWorkspaceTab("run");
  }, [activeWorkspaceTab, debugProject]);

  async function run(action, project = selected) {
    if (!project) return;
    setActiveWorkspaceTab("run");
    setBusySlug(project.slug);
    appendTerminal(`$ systemctl ${action} ${project.unit}`);
    try {
      const payload = await api(`/projects/${project.slug}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      appendTerminal(commandBlock(payload) || "OK");
      await refresh({ quiet: true });
    } catch (error) {
      appendTerminal(`ERROR: ${error.message}`);
    } finally {
      setBusySlug("");
    }
  }

  async function logs(project = selected) {
    if (!project) return;
    setActiveWorkspaceTab("run");
    setBusySlug(project.slug);
    appendTerminal(`$ journalctl -u ${project.unit} -n 160 --no-pager -o short-iso`);
    try {
      const payload = await api(`/projects/${project.slug}/logs`);
      appendTerminal(commandBlock(payload) || "(aucun log)");
      await refresh({ quiet: true });
    } catch (error) {
      appendTerminal(`ERROR: ${error.message}`);
    } finally {
      setBusySlug("");
    }
  }

  function openProjectTerminal(project = selected) {
    if (!project) return;
    setSelectedSlug(project.slug);
    setActiveWorkspaceTab(`terminal:${project.slug}`);
    setTerminalSlugs((current) => {
      if (current.has(project.slug)) return current;
      const next = new Set(current);
      next.add(project.slug);
      return next;
    });
  }

  function closeProjectTerminal(project = selected) {
    if (!project) return;
    setActiveWorkspaceTab((current) => (current === `terminal:${project.slug}` ? "run" : current));
    setTerminalSlugs((current) => {
      if (!current.has(project.slug)) return current;
      const next = new Set(current);
      next.delete(project.slug);
      return next;
    });
  }

  function saveToken(event) {
    event.preventDefault();
    window.localStorage.setItem("projectLauncherKey", token);
    refresh();
  }

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="grid h-full min-h-0 grid-cols-[360px_minmax(0,1fr)] max-lg:grid-cols-1 max-lg:grid-rows-[420px_minmax(0,1fr)]">
        <aside className="min-h-0 border-r border-border bg-sidebar max-lg:border-b max-lg:border-r-0">
          <div className="flex h-full flex-col">
            <div className="flex h-20 items-center justify-between gap-3 border-b border-border px-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-primary" />
                  <h1 className="truncate text-lg font-semibold">Project Launcher</h1>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {projects.length} projets systemd
                </p>
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => refresh()}
                disabled={loading}
                aria-label="Rafraichir"
              >
                <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              </Button>
            </div>

            {!initialToken ? (
              <form className="border-b border-border p-4" onSubmit={saveToken}>
                <label className="text-sm font-medium" htmlFor="token">
                  Cle d'acces
                </label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="token"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    placeholder="key"
                  />
                  <Button type="submit">OK</Button>
                </div>
              </form>
            ) : null}

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-2 p-3">
                {projects.map((project) => {
                  const isSelected = project.slug === selected?.slug;
                  const isBusy = busySlug === project.slug;
                  const running = isRunning(project);
                  const hasProjectTerminal = terminalSlugs.has(project.slug);
                  return (
                    <div
                      key={project.slug}
                      onClick={() => {
                        setSelectedSlug(project.slug);
                        openProjectUrl(project);
                      }}
                      className={[
                        "w-full cursor-pointer rounded-lg border p-3 text-left transition-colors",
                        isSelected
                          ? "border-primary/45 bg-accent"
                          : "border-transparent hover:border-border hover:bg-accent/60",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">{project.slug}</div>
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>:{project.port || "?"}</span>
                            <span>{project.subState}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <Button
                            type="button"
                            size="icon"
                            variant={hasProjectTerminal ? "secondary" : "outline"}
                            disabled={isBusy}
                            onClick={(event) => {
                              event.stopPropagation();
                              openProjectTerminal(project);
                            }}
                            aria-label={`Terminal ${project.slug}`}
                          >
                            <SquareTerminal className="h-4 w-4" />
                          </Button>
                          {running ? (
                            <Button
                              type="button"
                              size="icon"
                              variant="destructive"
                              disabled={isBusy}
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedSlug(project.slug);
                                run("stop", project);
                              }}
                              aria-label={`Stopper ${project.slug}`}
                            >
                              {isBusy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Power className="h-4 w-4" />
                              )}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="icon"
                              variant="default"
                              disabled={isBusy}
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedSlug(project.slug);
                                run("start", project);
                              }}
                              aria-label={`Lancer ${project.slug}`}
                            >
                              {isBusy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Play className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <Badge variant={statusTone(project)}>{statusLabel(project)}</Badge>
                        <span className="truncate text-xs text-muted-foreground">
                          {project.unitFileState}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        </aside>

        <main className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
          <section className="border-b border-border bg-panel px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <h2 className="truncate text-xl font-semibold">
                    {selected?.slug || "Aucun projet"}
                  </h2>
                  {selected ? (
                    <Badge variant={statusTone(selected)}>{statusLabel(selected)}</Badge>
                  ) : null}
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {selected
                    ? `${selected.workingDirectory} · ${selected.unit}`
                    : "Les projets apparaitront ici."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => openProjectTerminal()}
                  disabled={!selected}
                >
                  <SquareTerminal className="h-4 w-4" />
                  Terminal
                </Button>
                <Button
                  variant="outline"
                  onClick={() => logs()}
                  disabled={!selected || Boolean(busySlug)}
                >
                  <FileText className="h-4 w-4" />
                  Logs
                </Button>
                {isRunning(selected) ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => run("restart")}
                      disabled={!selected || Boolean(busySlug)}
                    >
                      <RotateCcw className="h-4 w-4" />
                      Restart
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => run("stop")}
                      disabled={!selected || Boolean(busySlug)}
                    >
                      <Power className="h-4 w-4" />
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="default"
                    onClick={() => run("start")}
                    disabled={!selected || Boolean(busySlug)}
                  >
                    <Play className="h-4 w-4" />
                    Play
                  </Button>
                )}
                <Button
                  variant="secondary"
                  asChild
                  className={!selected ? "pointer-events-none opacity-45" : ""}
                >
                  <a
                    href={selected?.hostUrl || selected?.pathUrl || "#"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Ouvrir
                  </a>
                </Button>
              </div>
            </div>
          </section>

          <section className="grid min-h-0 overflow-hidden grid-cols-[minmax(0,1fr)_300px] gap-0 max-xl:grid-cols-1">
            <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-terminal">
              <div
                className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border bg-panel px-2"
                role="tablist"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeWorkspaceTab === "run"}
                  onClick={() => setActiveWorkspaceTab("run")}
                  className={[
                    "flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors",
                    activeWorkspaceTab === "run"
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  <FileText className="h-4 w-4" />
                  Run
                </button>
                {terminalProjects.map((project) => {
                  const tabId = `terminal:${project.slug}`;
                  const active = activeWorkspaceTab === tabId;
                  return (
                    <button
                      key={project.slug}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setActiveWorkspaceTab(tabId)}
                      className={[
                        "flex h-10 max-w-[220px] shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors",
                        active
                          ? "border-primary text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      ].join(" ")}
                    >
                      <SquareTerminal className="h-4 w-4 shrink-0" />
                      <span className="truncate">{project.slug}</span>
                    </button>
                  );
                })}
              </div>

              <div className="min-h-0 overflow-hidden">
                {activeWorkspaceTab === "run" ? (
                  <ScrollArea className="terminal-scroll h-full">
                    <pre className="min-h-full whitespace-pre-wrap break-words p-5 font-mono text-[13px] leading-6 text-terminal-foreground">
                      {terminal || "En attente d'une action."}
                    </pre>
                  </ScrollArea>
                ) : debugProject ? (
                  <ProjectTerminal
                    project={debugProject}
                    token={token}
                    onClose={() => closeProjectTerminal(debugProject)}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-5 text-sm text-muted-foreground">
                    Terminal indisponible.
                  </div>
                )}
              </div>
            </div>

            <div className="border-l border-border bg-panel p-4 max-xl:hidden">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" />
                    Etat
                  </CardTitle>
                  <CardDescription>Lecture systemd en direct</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Active</span>
                    <span>{selected?.activeState || "-"}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Sub</span>
                    <span>{selected?.subState || "-"}</span>
                  </div>
                  <Separator />
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">PID</span>
                    <span>{selected?.mainPid || "-"}</span>
                  </div>
                  <Separator />
                  <div className="space-y-1">
                    <span className="text-muted-foreground">Run script</span>
                    <span className="block break-all font-mono text-xs">
                      {selected?.runScript || "-"}
                    </span>
                  </div>
                  <Separator />
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Restarts</span>
                    <span>{selected?.restarts || "0"}</span>
                  </div>
                  <Separator />
                  <div className="space-y-1">
                    <span className="text-muted-foreground">URL</span>
                    <a
                      className="block break-all text-primary hover:underline"
                      href={selected?.hostUrl || selected?.pathUrl || "#"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {selected?.hostUrl || selected?.pathUrl || "-"}
                    </a>
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
