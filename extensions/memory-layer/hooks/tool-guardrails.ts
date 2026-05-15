import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state, isCodeFile } from "../state";
import { getKnownRepos } from "../host/project-detector";
import path from "node:path";

interface GuardrailsDeps {
  state: typeof state;
  getKnownRepos: typeof getKnownRepos;
  isCodeFile: typeof isCodeFile;
}

export function registerToolGuardrails(pi: ExtensionAPI, deps: GuardrailsDeps) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === "memory-code") {
      deps.state.lastMemoryToolCall = Date.now();
      const file = String(input?.file || "");
      if (file) {
        deps.state.exploredFiles.add(file.toLowerCase());
        deps.state.exploredFiles.add(path.basename(file).toLowerCase());
      }
      return;
    }
    if (toolName.startsWith("memory-")) {
      deps.state.lastMemoryToolCall = Date.now();
      return;
    }

    if (toolName === "bash" && typeof input?.command === "string") {
      const cmd = input.command as string;
      if (/\b(rg\b|grep\b|ag\b|ack\b|find\b).*\.(ts|js|tsx|jsx|py|go|rs|java)/i.test(cmd)) {
        const repos = await deps.getKnownRepos();
        const resolvedCwd = path.resolve(process.cwd());
        const matchedRepo =
          repos.find(r => resolvedCwd.startsWith(path.resolve(r.path))) ||
          repos.find(r => deps.state.currentProject?.toLowerCase() === r.name.toLowerCase());
        if (matchedRepo) {
          return {
            block: true,
            reason: `Code search detected in indexed repo "${matchedRepo.name}". Use \`memory-code\` instead:\n` +
              `• \`memory-code outline --repo ${matchedRepo.name} --file <path>\` — file structure\n` +
              `• \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` — call hierarchy\n` +
              `• \`memory-code deps --repo ${matchedRepo.name}\` — dependency graph\n` +
              `• \`memory-code importance --repo ${matchedRepo.name}\` — hotspots & churn`,
          };
        }
        if (deps.state.nudgeCountThisSession < deps.state.MAX_NUDGES_PER_SESSION) {
          deps.state.nudgeCountThisSession++;
          ctx.ui.notify(
            `💡 Use \`memory-code\` for structured analysis. Index this repo first: \`memory-code index-repo\``,
            "info",
          );
        }
        return;
      }
    }

    if (toolName === "read" && typeof input?.path === "string") {
      const filePath = input.path as string;

      if (!deps.isCodeFile(filePath)) {return;}

      if (filePath.includes("node_modules")) {return;}

      if (input.offset || input.limit) {return;}

      const absPath = path.resolve(filePath);

      const repos = await deps.getKnownRepos();
      const matchedRepo = repos.find(r =>
        absPath.toLowerCase().startsWith(`${r.path.toLowerCase()  }/`) ||
        absPath.toLowerCase() === r.path.toLowerCase()
      );

      if (!matchedRepo) {
        if (deps.state.nudgeCountThisSession < deps.state.MAX_NUDGES_PER_SESSION) {
          deps.state.nudgeCountThisSession++;
          ctx.ui.notify(
            `💡 This code file isn't in an indexed repo. Index it: \`memory-code index-repo\``,
            "info",
          );
        }
        return;
      }

      const basename = path.basename(filePath).toLowerCase();
      const relPath = path.relative(matchedRepo.path, absPath).toLowerCase();
      if (deps.state.exploredFiles.has(basename) || deps.state.exploredFiles.has(relPath) || deps.state.exploredFiles.has(absPath.toLowerCase())) {
        return;
      }

      return {
        block: true,
        reason: `Use \`memory-code\` first to understand "${path.basename(filePath)}" before reading it:\n` +
          `• \`memory-code outline --repo ${matchedRepo.name} --file ${relPath || path.basename(filePath)}\` — file structure & symbols\n` +
          `• \`memory-code callers --repo ${matchedRepo.name} --symbol <name>\` — who calls what\n` +
          `• \`memory-code deps --repo ${matchedRepo.name}\` — dependency graph\n` +
          `After reviewing the outline, use \`read\` with \`offset\`/\`limit\` for targeted editing.`,
      };
    }
  });
}
