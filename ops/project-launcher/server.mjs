#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "dist"))
  ? path.join(__dirname, "dist")
  : path.join(__dirname, "public");
const UNIT_DIR = "/etc/systemd/system";
const CADDYFILE = "/etc/caddy/Caddyfile";
const CONFIG_SCRIPT = "/usr/local/bin/project-autostart";
const CONFIG_STATE_FILE = "/var/lib/project-launcher/config-state.json";
const RUN_DIR = "/var/lib/project-autostart/run";
const HOST = process.env.PROJECT_LAUNCHER_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PROJECT_LAUNCHER_PORT ?? "14999");
const TOKEN = process.env.PROJECT_LAUNCHER_TOKEN ?? "aada7222698a689d646aeb24c22a941715a7";

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function command(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        });
      },
    );
  });
}

function output(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    }).trim();
  } catch {
    return "";
  }
}

function publicIp() {
  return (
    output("bash", [
      "-lc",
      "ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1",
    ]) || "127.0.0.1"
  );
}

function parseUnit(unitName) {
  const unitPath = path.join(UNIT_DIR, unitName);
  const content = fs.readFileSync(unitPath, "utf8");
  const slug = unitName.replace(/^autoproject-/, "").replace(/\.service$/, "");
  const port = content.match(/^Environment=PORT=(\d+)$/m)?.[1] ?? "";
  const workingDirectory = content.match(/^WorkingDirectory=(.+)$/m)?.[1] ?? "";
  const execStart = content.match(/^ExecStart=(.+)$/m)?.[1] ?? "";
  const runScript = execStart.startsWith(RUN_DIR) ? execStart : "";

  return { slug, unit: unitName, port, workingDirectory, execStart, runScript };
}

function projectUnits() {
  return fs
    .readdirSync(UNIT_DIR)
    .filter((name) => /^autoproject-[a-z0-9-]+\.service$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readConfigState() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeConfigState(state) {
  fs.mkdirSync(path.dirname(CONFIG_STATE_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_STATE_FILE, JSON.stringify(state, null, 2));
}

function configSignature(project) {
  return {
    version: 2,
    slug: project.slug,
    unit: project.unit,
    scriptMtime: fileMtimeMs(CONFIG_SCRIPT),
    unitMtime: fileMtimeMs(path.join(UNIT_DIR, project.unit)),
    runScriptMtime: project.runScript ? fileMtimeMs(project.runScript) : 0,
    caddyMtime: fileMtimeMs(CADDYFILE),
  };
}

function isProjectConfigReady(project) {
  if (!fs.existsSync(path.join(UNIT_DIR, project.unit))) return false;
  const caddy = fs.existsSync(CADDYFILE) ? fs.readFileSync(CADDYFILE, "utf8") : "";
  if (!caddy.includes(`/${project.slug}*`) || !caddy.includes(`127.0.0.1:${project.port}`))
    return false;

  const previous = readConfigState();
  const current = configSignature(project);
  return Boolean(
    previous &&
    previous.version === current.version &&
    previous.slug === current.slug &&
    previous.unit === current.unit &&
    previous.scriptMtime === current.scriptMtime &&
    previous.unitMtime === current.unitMtime &&
    previous.caddyMtime === current.caddyMtime,
  );
}

async function ensureProjectConfig(project) {
  if (isProjectConfigReady(project)) {
    return {
      ran: false,
      command: `${CONFIG_SCRIPT} --config-only`,
      stdout: `Config deja valide pour ${project.slug}.`,
      stderr: "",
      code: 0,
    };
  }

  const projectRoot = project.workingDirectory.startsWith("/root/")
    ? project.workingDirectory.slice("/root/".length).split(path.sep)[0]
    : project.slug;
  const result = await command(CONFIG_SCRIPT, ["--config-only"], {
    timeout: 180_000,
    env: {
      ...process.env,
      PROJECT_AUTOSTART_CODEX_ONLY_PROJECT: projectRoot,
    },
  });
  if (!result.ok) {
    return {
      ran: true,
      command: `${CONFIG_SCRIPT} --config-only`,
      ...result,
    };
  }

  const refreshed = resolveProject(project.slug);
  if (refreshed) writeConfigState(configSignature(refreshed));

  return {
    ran: true,
    command: `${CONFIG_SCRIPT} --config-only`,
    ...result,
  };
}

async function unitStatus(unit) {
  const result = await command("systemctl", [
    "show",
    unit,
    "--property=ActiveState,SubState,LoadState,UnitFileState,MainPID,NRestarts",
    "--no-page",
  ]);

  const fields = Object.fromEntries(
    result.stdout
      .split("\n")
      .map((line) => line.split("="))
      .filter(([key]) => key),
  );

  return {
    activeState: fields.ActiveState ?? "unknown",
    subState: fields.SubState ?? "unknown",
    loadState: fields.LoadState ?? "unknown",
    unitFileState: fields.UnitFileState ?? "unknown",
    mainPid: fields.MainPID ?? "0",
    restarts: fields.NRestarts ?? "0",
  };
}

async function listProjects() {
  const ip = publicIp();
  const units = projectUnits();
  const projects = await Promise.all(
    units.map(async (unit) => {
      const project = parseUnit(unit);
      return {
        ...project,
        ...(await unitStatus(unit)),
        pathUrl: `http://${ip}/${project.slug}`,
        hostUrl: `http://${project.slug}.${ip}.sslip.io`,
      };
    }),
  );
  return projects;
}

function resolveProject(slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const unit = `autoproject-${slug}.service`;
  const unitPath = path.join(UNIT_DIR, unit);
  if (!fs.existsSync(unitPath)) return null;
  return parseUnit(unit);
}

async function journal(unit, lines = 120) {
  const result = await command("journalctl", [
    "-u",
    unit,
    "-n",
    String(lines),
    "--no-pager",
    "-o",
    "short-iso",
  ]);
  return result.stdout || result.stderr || "";
}

function hasValidToken(req, url) {
  const headerToken = req.headers["x-launcher-token"];
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const queryToken = url.searchParams.get("key");
  return [headerToken, bearer, queryToken].some((value) => value === TOKEN);
}

function terminalPath(url) {
  return url.pathname === "/terminal" || url.pathname === "/project-launcher/terminal";
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function serveFile(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    text(res, 403, "Forbidden");
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      fs.readFile(indexPath, (indexError, indexData) => {
        if (indexError) {
          text(res, 404, "Not found");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(indexData);
      });
      return;
    }

    res.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(resolved)) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleApi(req, res, url) {
  if (!hasValidToken(req, url)) {
    json(res, 401, { error: "Invalid launcher key" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    json(res, 200, { projects: await listProjects() });
    return;
  }

  const match = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/(start|stop|restart|logs)$/);
  if (!match) {
    json(res, 404, { error: "Unknown API route" });
    return;
  }

  const [, slug, action] = match;
  const project = resolveProject(slug);
  if (!project) {
    json(res, 404, { error: "Unknown project" });
    return;
  }

  if (action === "logs") {
    json(res, 200, {
      project,
      command: `journalctl -u ${project.unit} -n 160 --no-pager -o short-iso`,
      output: await journal(project.unit, 160),
      status: await unitStatus(project.unit),
    });
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  await readJsonBody(req).catch(() => ({}));
  const config = action === "start" ? await ensureProjectConfig(project) : null;
  if (config && !config.ok && config.code !== 0) {
    json(res, 500, {
      project,
      config,
      command: config.command,
      stdout: config.stdout,
      stderr: config.stderr,
      code: config.code,
      status: await unitStatus(project.unit),
    });
    return;
  }

  const runnableProject = action === "start" ? resolveProject(slug) || project : project;
  const effectiveAction = action === "start" && config?.ran ? "restart" : action;
  const systemctlArgs = [effectiveAction, runnableProject.unit];
  const result = await command("systemctl", systemctlArgs);
  const logs = await journal(runnableProject.unit, 80);

  json(res, result.ok ? 200 : 500, {
    project: runnableProject,
    config,
    command: `systemctl ${systemctlArgs.join(" ")}`,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    logs,
    status: await unitStatus(runnableProject.unit),
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => json(res, 500, { error: error.message }));
    return;
  }

  const isAsset = url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico";
  if (!isAsset && !hasValidToken(req, url)) {
    text(res, 401, "Invalid launcher key");
    return;
  }

  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  serveFile(res, path.join(PUBLIC_DIR, requestPath));
});

const terminalServer = new WebSocketServer({ noServer: true });
const TERMINAL_REPLAY_LIMIT = 200_000;
const TERMINAL_IDLE_TTL_MS = Number(
  process.env.PROJECT_LAUNCHER_TERMINAL_IDLE_TTL_MS ?? 30 * 60 * 1000,
);
const terminalSessions = new Map();

function terminalIntro(project) {
  const status = output("systemctl", [
    "show",
    project.unit,
    "--property=ActiveState,SubState,NRestarts,MemoryCurrent,MemoryPeak",
    "--no-page",
  ]);
  const logs = output("journalctl", ["-u", project.unit, "-n", "120", "--no-pager", "-o", "cat"]);
  const notableLogs = logs
    .split("\n")
    .filter((line) =>
      /(error|failed|fail|oom|killed|refused|cannot|warning|warn|exception|traceback)/i.test(line),
    )
    .slice(-12);

  return [
    "",
    `[Project Launcher] Terminal shell dans ${project.workingDirectory}`,
    `[Project Launcher] Aucun agent IA n'a ete lance. Tape tes commandes directement.`,
    `[Project Launcher] Unite: ${project.unit} | Script: ${project.runScript || project.execStart} | Port: ${project.port}`,
    status ? `[Project Launcher] Etat systemd:\n${status}` : "",
    notableLogs.length > 0
      ? `[Project Launcher] Lignes de logs recentes a verifier:\n${notableLogs.map((line) => `  ${line}`).join("\n")}`
      : "[Project Launcher] Aucun warning/erreur recent detecte dans les derniers logs.",
    "",
  ]
    .filter(Boolean)
    .join("\r\n");
}

function createProjectTerminalSession(project, cols, rows) {
  let term;
  try {
    term = pty.spawn("bash", ["--noprofile", "--norc", "-i"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: project.workingDirectory,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PS1: `launcher:${project.slug}:\\w\\$ `,
      },
    });
  } catch (error) {
    throw error;
  }

  const session = {
    project,
    term,
    clients: new Set(),
    replay: "",
    exited: false,
    idleTimer: null,
  };

  const recordAndBroadcast = (type, data) => {
    session.replay = `${session.replay}${data}`.slice(-TERMINAL_REPLAY_LIMIT);
    const payload = JSON.stringify({ type, data });
    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  };

  term.onData((data) => {
    recordAndBroadcast("data", data);
  });

  term.onExit(({ exitCode, signal }) => {
    session.exited = true;
    recordAndBroadcast(
      "exit",
      `\r\n[Project Launcher] Terminal termine: code=${exitCode} signal=${signal ?? ""}\r\n`,
    );
    terminalSessions.delete(project.slug);
    for (const client of session.clients) {
      client.close();
    }
  });

  recordAndBroadcast("data", `${terminalIntro(project)}\r\n`);
  terminalSessions.set(project.slug, session);
  return session;
}

function getProjectTerminalSession(project, cols, rows) {
  const existing = terminalSessions.get(project.slug);
  if (
    existing &&
    existing.project.workingDirectory === project.workingDirectory &&
    !existing.exited
  ) {
    try {
      existing.term.resize(cols, rows);
    } catch {}
    return existing;
  }

  if (existing && !existing.exited) {
    try {
      existing.term.kill();
    } catch {}
    terminalSessions.delete(project.slug);
  }

  return createProjectTerminalSession(project, cols, rows);
}

function terminateProjectTerminalSession(slug) {
  const session = terminalSessions.get(slug);
  if (!session || session.exited) return;
  terminalSessions.delete(slug);
  session.exited = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  try {
    session.term.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      session.term.kill("SIGKILL");
    } catch {}
  }, 1000);
}

function scheduleTerminalIdleTermination(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  if (session.clients.size > 0 || session.exited || TERMINAL_IDLE_TTL_MS <= 0) return;
  session.idleTimer = setTimeout(() => {
    if (session.clients.size === 0 && !session.exited) {
      terminateProjectTerminalSession(session.project.slug);
    }
  }, TERMINAL_IDLE_TTL_MS);
}

function startProjectTerminal(ws, project, url) {
  const cols = Math.max(40, Math.min(240, Number(url.searchParams.get("cols") || "120")));
  const rows = Math.max(10, Math.min(80, Number(url.searchParams.get("rows") || "32")));
  let session;
  try {
    session = getProjectTerminalSession(project, cols, rows);
  } catch (error) {
    ws.send(
      JSON.stringify({
        type: "error",
        data: `Impossible de lancer le terminal: ${error.message}\r\n`,
      }),
    );
    ws.close();
    return;
  }

  session.clients.add(ws);
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  ws.send(JSON.stringify({ type: "meta", data: `Terminal: ${project.slug}` }));
  if (session.replay) {
    ws.send(JSON.stringify({ type: "data", data: session.replay }));
  }
  ws.send(
    JSON.stringify({
      type: "data",
      data: `\r\n[Project Launcher] Terminal attache a ${project.slug}\r\n`,
    }),
  );

  ws.on("message", (payload) => {
    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }

    if (message.type === "input") {
      session.term.write(String(message.data ?? ""));
      return;
    }

    if (message.type === "resize") {
      const nextCols = Math.max(40, Math.min(240, Number(message.cols || cols)));
      const nextRows = Math.max(10, Math.min(80, Number(message.rows || rows)));
      session.term.resize(nextCols, nextRows);
      return;
    }

    if (message.type === "terminate") {
      terminateProjectTerminalSession(project.slug);
      ws.close();
    }
  });

  ws.on("close", () => {
    session.clients.delete(ws);
    scheduleTerminalIdleTermination(session);
  });
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!terminalPath(url)) {
    socket.destroy();
    return;
  }

  if (!hasValidToken(req, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const project = resolveProject(url.searchParams.get("slug") || "");
  if (!project || !project.workingDirectory || !fs.existsSync(project.workingDirectory)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  terminalServer.handleUpgrade(req, socket, head, (ws) => {
    terminalServer.emit("connection", ws, req, project, url);
  });
});

terminalServer.on("connection", (ws, req, project, url) => startProjectTerminal(ws, project, url));

server.listen(PORT, HOST, () => {
  console.log(`Project launcher listening on http://${HOST}:${PORT}`);
});
