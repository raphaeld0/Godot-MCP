#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const server = new McpServer({
  name: "godot-deepseek-mcp",
  version: "0.1.0",
});

function executableCandidates(): string[] {
  const configuredPath = process.env.GODOT_PATH?.trim();
  if (configuredPath) {
    return [configuredPath];
  }

  return process.platform === "win32"
    ? ["godot.exe", "godot4.exe"]
    : ["godot", "godot4"];
}

async function findGodotExecutable(): Promise<string> {
  const candidates = executableCandidates();

  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        throw new Error(`Godot executable was not found at GODOT_PATH: ${candidate}`);
      }
    }

    const pathEntries = (process.env.PATH ?? "").split(delimiter);
    for (const entry of pathEntries) {
      const executable = join(entry, candidate);
      try {
        await access(executable);
        return executable;
      } catch {
        // Continue searching PATH for this candidate.
      }
    }
  }

  throw new Error(
    "Godot was not found. Set GODOT_PATH to the full path of the Godot executable.",
  );
}

server.registerTool(
  "get_godot_version",
  {
    description: "Return the version of the locally installed Godot executable.",
  },
  async () => {
    const executable = await findGodotExecutable();
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    const version = (stdout || stderr).trim();

    if (!version) {
      throw new Error("Godot returned an empty version response.");
    }

    return { content: [{ type: "text", text: version }] };
  },
);

server.registerTool(
  "inspect_godot_project",
  {
    description:
      "Read basic metadata from a Godot project's project.godot file without running the project.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Absolute or relative path to the project folder."),
    },
  },
  async ({ projectPath }) => {
    const directory = resolve(projectPath);
    const directoryInfo = await stat(directory);
    if (!directoryInfo.isDirectory()) {
      throw new Error(`Project path is not a directory: ${directory}`);
    }

    const projectFile = join(directory, "project.godot");
    const contents = await readFile(projectFile, "utf8");
    const readSetting = (section: string, key: string): string | undefined => {
      const sectionPattern = new RegExp(
        `\\[${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([\\s\\S]*?)(?=\\n\\[|$)`,
        "m",
      );
      const sectionContents = contents.match(sectionPattern)?.[1];
      const settingPattern = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, "m");
      const value = sectionContents?.match(settingPattern)?.[1];
      return value?.replace(/^["']|["']$/g, "");
    };

    const rootConfigVersion =
      contents.match(/^config_version\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "") ??
      "(not set)";
    const metadata = {
      path: directory,
      name: readSetting("application", "config/name") ?? "(not set)",
      mainScene: readSetting("application", "run/main_scene") ?? "(not set)",
      configVersion: rootConfigVersion,
    };

    return {
      content: [
        {
          type: "text",
          text: [
            `Project: ${metadata.name}`,
            `Path: ${metadata.path}`,
            `Main scene: ${metadata.mainScene}`,
            `Config version: ${metadata.configVersion}`,
          ].join("\n"),
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Godot MCP server failed to start: ${message}`);
  process.exitCode = 1;
});
