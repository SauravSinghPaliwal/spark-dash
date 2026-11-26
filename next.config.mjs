import path from "node:path";
import { fileURLToPath } from "node:url";

export default {
  reactStrictMode: true,
  output: "standalone", // self-contained server bundle, used by the desktop app
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
};
