// Copies static assets next to the standalone server so it is fully self-contained.
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";

const std = ".next/standalone";
if (!existsSync(`${std}/server.js`)) throw new Error("Run `next build` first (output: standalone).");
rmSync(`${std}/.next/static`, { recursive: true, force: true });
cpSync(".next/static", `${std}/.next/static`, { recursive: true });
cpSync("public", `${std}/public`, { recursive: true });
// electron-builder silently drops any directory named node_modules from extraResources,
// so ship the dependencies as "modules" and let the launcher add it to NODE_PATH.
if (existsSync(`${std}/node_modules`)) {
  rmSync(`${std}/modules`, { recursive: true, force: true });
  renameSync(`${std}/node_modules`, `${std}/modules`);
}
console.log("standalone bundle ready");
