import { execFileSync } from "node:child_process";
import { PKG_ROOT, state } from "../state";

export async function ensureNativeModules(): Promise<void> {
  if (state.nativeChecked) {return;}
  state.nativeChecked = true;
  try {
    require.resolve("better-sqlite3");
    const mod = require("better-sqlite3");
    if (typeof mod !== "function") {throw new Error("not a function");}
  } catch {
    console.error("[memory-layer] better-sqlite3 not compiled, attempting rebuild...");
    try {
      execFileSync("npm", ["rebuild", "better-sqlite3"], {
        cwd: PKG_ROOT,
        encoding: "utf8",
        timeout: 120000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.error("[memory-layer] better-sqlite3 rebuilt successfully");
    } catch (rebuildErr) {
      console.error("[memory-layer] Failed to rebuild better-sqlite3:", rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr));
      console.error("[memory-layer] Install build tools (build-essential / Xcode CLI tools) and run: npm rebuild better-sqlite3");
    }
  }
}
