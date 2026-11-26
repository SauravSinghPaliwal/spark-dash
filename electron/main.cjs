// Spark Dash desktop shell: runs the bundled Next.js server on a private
// loopback port and shows it in a native window.
const { app, BrowserWindow, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");

// Chromium refuses to start as root without this (only matters when launched as root).
if (typeof process.getuid === "function" && process.getuid() === 0) app.commandLine.appendSwitch("no-sandbox");

// The GPU process segfaults on some ARM + NVIDIA driver setups; this UI renders fine in software.
app.disableHardwareAcceleration();

let server = null;
let win = null;

const serverDir = () => (app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "..", ".next", "standalone"));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function waitUp(port, timeoutMs = 30000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => { res.resume(); resolve(); });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => (Date.now() - t0 > timeoutMs ? reject(new Error("Server did not start")) : setTimeout(tryOnce, 250));
    tryOnce();
  });
}

async function startServer() {
  const port = await freePort();
  server = spawn(process.execPath, ["server.js"], {
    cwd: serverDir(),
    env: { ...process.env, NODE_PATH: path.join(serverDir(), "modules"), ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  });
  server.on("exit", (code) => { if (!app.isQuitting && code) console.error("server exited", code); });
  await waitUp(port);
  return port;
}

function stopServer() {
  if (server && !server.killed) server.kill();
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 420, minHeight: 600,
    title: "Spark Dash", backgroundColor: "#111418", autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<body style="margin:0;background:#111418;color:#8f99a8;font:13px system-ui;display:grid;place-items:center;height:100vh">Starting Spark Dash…</body>`));
  try {
    const port = await startServer();
    const base = `http://127.0.0.1:${port}`;
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); shell.openExternal(url); } });
    await win.loadURL(base);
  } catch (err) {
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<body style="margin:0;background:#111418;color:#e76a6e;font:13px system-ui;padding:32px">Failed to start the dashboard server:<pre>${String(err && err.message)}</pre></body>`));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
  });
  app.on("before-quit", () => { app.isQuitting = true; stopServer(); });
  app.on("window-all-closed", () => { stopServer(); app.quit(); });
}
