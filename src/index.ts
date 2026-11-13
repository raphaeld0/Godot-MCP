#!/usr/bin/env node

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MAX_LOG_LINES = 500;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_LINE_BYTES = 64 * 1024;
const IGNORED_PROJECT_DIRECTORIES = new Set([".git", ".godot", "node_modules"]);
const execFileAsync = promisify(execFile);

interface ProjectMetadata {
  path: string;
  name: string;
  mainScene: string;
  configVersion: string;
}

interface DebugLine {
  stream: "stdout" | "stderr";
  text: string;
}

interface RunningProject {
  child: ChildProcess;
  projectPath: string;
  startedAt: string;
  status: "running" | "stopping" | "stopped" | "exited" | "error";
  exitCode: number | null;
  logs: DebugLine[];
  logBytes: number;
  decoders: {
    stdout: StringDecoder;
    stderr: StringDecoder;
  };
  partialLines: {
    stdout: string;
    stderr: string;
  };
  closed: Promise<void>;
  resolveClosed: () => void;
}

const server = new McpServer({
  name: "godot-deepseek-mcp",
  version: "0.1.0",
});

let runningProject: RunningProject | undefined;

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
  for (const candidate of executableCandidates()) {
    if (isAbsolute(candidate)) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        throw new Error(`Godot executable was not found at GODOT_PATH: ${candidate}`);
      }
    }

    for (const entry of (process.env.PATH ?? "").split(delimiter)) {
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

async function validateProject(projectPath: string): Promise<string> {
  const directory = resolve(projectPath);
  const directoryInfo = await stat(directory);
  if (!directoryInfo.isDirectory()) {
    throw new Error(`Project path is not a directory: ${directory}`);
  }

  const projectFile = join(directory, "project.godot");
  const fileInfo = await stat(projectFile);
  if (!fileInfo.isFile()) {
    throw new Error(`Godot project file not found: ${projectFile}`);
  }

  return directory;
}

function readProjectSetting(contents: string, section: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const settingPattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(.*?)\\s*$`);
  let currentSection = "";

  for (const line of contents.split(/\r?\n/)) {
    const sectionHeader = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionHeader) {
      currentSection = sectionHeader[1];
      continue;
    }

    if (currentSection !== section) {
      continue;
    }

    const value = line.match(settingPattern)?.[1];
    if (value !== undefined) {
      const trimmedValue = value.trim();
      if (
        (trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
        (trimmedValue.startsWith("'") && trimmedValue.endsWith("'"))
      ) {
        return trimmedValue.slice(1, -1);
      }
      return trimmedValue;
    }
  }

  return undefined;
}

async function readProjectMetadata(projectPath: string): Promise<ProjectMetadata> {
  const directory = await validateProject(projectPath);
  const contents = await readFile(join(directory, "project.godot"), "utf8");
  const configVersion = readProjectSetting(contents, "", "config_version") ?? "(not set)";

  return {
    path: directory,
    name: readProjectSetting(contents, "application", "config/name") ?? "(not set)",
    mainScene: readProjectSetting(contents, "application", "run/main_scene") ?? "(not set)",
    configVersion,
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function appendOutput(project: RunningProject, stream: "stdout" | "stderr", chunk: Buffer): void {
  const decoder = project.decoders[stream];
  const combined = project.partialLines[stream] + decoder.write(chunk);
  const lines = combined.split(/\r?\n/);
  project.partialLines[stream] = lines.pop() ?? "";

  for (const line of lines) {
    appendLogLine(project, stream, line);
  }

  if (Buffer.byteLength(project.partialLines[stream], "utf8") > MAX_LOG_LINE_BYTES) {
    appendLogLine(project, stream, project.partialLines[stream]);
    project.partialLines[stream] = "";
  }
}

function appendLogLine(project: RunningProject, stream: "stdout" | "stderr", text: string): void {
  const encoded = Buffer.from(text, "utf8");
  let boundedText = text;
  if (encoded.length > MAX_LOG_LINE_BYTES) {
    let start = encoded.length - MAX_LOG_LINE_BYTES;
    while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
      start++;
    }
    boundedText = `${encoded.subarray(start).toString("utf8")} [line truncated]`;
  }
  project.logs.push({ stream, text: boundedText });
  project.logBytes += Buffer.byteLength(boundedText, "utf8");
  while (project.logs.length > MAX_LOG_LINES || project.logBytes > MAX_LOG_BYTES) {
    const removed = project.logs.shift();
    if (removed) {
      project.logBytes -= Buffer.byteLength(removed.text, "utf8");
    }
  }
}

function flushPartialOutput(project: RunningProject, stream: "stdout" | "stderr"): void {
  const remaining = project.partialLines[stream] + project.decoders[stream].end();
  if (remaining) {
    appendLogLine(project, stream, remaining);
    project.partialLines[stream] = "";
  }
}

function attachProjectProcess(child: ChildProcess, projectPath: string): RunningProject {
  let resolveClosed = () => {};
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const project: RunningProject = {
    child,
    projectPath,
    startedAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    logs: [],
    logBytes: 0,
    decoders: {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    },
    partialLines: { stdout: "", stderr: "" },
    closed,
    resolveClosed,
  };

  child.stdout?.on("data", (chunk: Buffer) => appendOutput(project, "stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(project, "stderr", chunk));
  child.on("error", (error) => {
    project.status = "error";
    appendLogLine(project, "stderr", `Failed to run Godot: ${error.message}`);
    project.resolveClosed();
  });
  child.on("close", (code) => {
    flushPartialOutput(project, "stdout");
    flushPartialOutput(project, "stderr");
    project.exitCode = code;
    if (project.status !== "error") {
      project.status = project.status === "stopping" ? "stopped" : "exited";
    }
    project.resolveClosed();
  });

  return project;
}

server.registerTool(
  "get_godot_version",
  {
    description: "Return the version of the locally installed Godot executable.",
  },
  async () => {
    const executable = await findGodotExecutable();
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    const version = (stdout || stderr).trim();
    if (!version) {
      throw new Error("Godot returned an empty version response.");
    }

    return textResult(version);
  },
);

server.registerTool(
  "inspect_godot_project",
  {
    description:
      "Read basic metadata from a Godot project's project.godot file without running the project.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
    },
  },
  async ({ projectPath }) => {
    const metadata = await readProjectMetadata(projectPath);
    return textResult(
      [
        `Project: ${metadata.name}`,
        `Path: ${metadata.path}`,
        `Main scene: ${metadata.mainScene}`,
        `Config version: ${metadata.configVersion}`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "list_projects",
  {
    description:
      "Find Godot projects inside a directory. Scanning is limited by depth and result count.",
    inputSchema: {
      directory: z.string().min(1).describe("Directory to scan for project.godot files."),
      maxDepth: z.number().int().min(0).max(10).default(4),
      maxResults: z.number().int().min(1).max(200).default(100),
    },
  },
  async ({ directory, maxDepth, maxResults }) => {
    const root = resolve(directory);
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) {
      throw new Error(`Search path is not a directory: ${root}`);
    }

    const projects: ProjectMetadata[] = [];
    const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

    while (pending.length > 0 && projects.length < maxResults) {
      const current = pending.pop();
      if (!current) {
        break;
      }

      const entries = await readdir(current.directory, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name === "project.godot")) {
        projects.push(await readProjectMetadata(current.directory));
        continue;
      }

      if (current.depth < maxDepth) {
        for (const entry of entries) {
          if (
            entry.isDirectory() &&
            !IGNORED_PROJECT_DIRECTORIES.has(entry.name) &&
            !entry.name.startsWith(".")
          ) {
            pending.push({
              directory: join(current.directory, entry.name),
              depth: current.depth + 1,
            });
          }
        }
      }
    }

    return textResult(JSON.stringify({ directory: root, count: projects.length, projects }, null, 2));
  },
);

server.registerTool(
  "launch_editor",
  {
    description: "Launch the Godot editor for a validated project directory.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
    },
  },
  async ({ projectPath }) => {
    const directory = await validateProject(projectPath);
    const executable = await findGodotExecutable();
    const child = spawn(executable, ["--editor", "--path", directory], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("spawn", resolvePromise);
    });
    child.unref();

    return textResult(`Godot editor launched for ${directory} (PID ${child.pid ?? "unknown"}).`);
  },
);

server.registerTool(
  "run_project",
  {
    description:
      "Run a Godot project and capture its standard output and errors. Only one project can run at a time.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      headless: z.boolean().default(false).describe("Run without creating a game window."),
    },
  },
  async ({ projectPath, headless }) => {
    if (runningProject?.status === "running" || runningProject?.status === "stopping") {
      throw new Error(
        `A project is already ${runningProject.status}: ${runningProject.projectPath}. Stop it before starting another.`,
      );
    }

    const directory = await validateProject(projectPath);
    const executable = await findGodotExecutable();
    const args = ["--path", directory, "--verbose"];
    if (headless) {
      args.unshift("--headless");
    }

    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const project = attachProjectProcess(child, directory);
    runningProject = project;

    try {
      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("spawn", resolvePromise);
      });
    } catch (error) {
      project.status = "error";
      project.resolveClosed();
      throw new Error(
        `Could not launch Godot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return textResult(
      `Project started: ${directory}\nPID: ${child.pid ?? "unknown"}\nHeadless: ${headless}\nUse get_debug_output to read logs and stop_project to stop it.`,
    );
  },
);

server.registerTool(
  "get_debug_output",
  {
    description: "Return recent output and process status for the project started by this server.",
    inputSchema: {
      maxLines: z.number().int().min(1).max(MAX_LOG_LINES).default(100),
    },
  },
  async ({ maxLines }) => {
    if (!runningProject) {
      throw new Error("No project has been started by this server.");
    }

    const project = runningProject;
    const lines = project.logs.slice(-maxLines).map(({ stream, text }) => `[${stream}] ${text}`);
    const details = [
      `Project: ${project.projectPath}`,
      `Status: ${project.status}`,
      `PID: ${project.child.pid ?? "unknown"}`,
      `Started: ${project.startedAt}`,
      `Exit code: ${project.exitCode ?? "(still running or unavailable)"}`,
      `Showing ${lines.length} of ${project.logs.length} buffered log lines (buffer capped at ${MAX_LOG_LINES} lines).`,
      "",
      ...(lines.length > 0 ? lines : ["No debug output captured yet."]),
    ];

    return textResult(details.join("\n"));
  },
);

server.registerTool(
  "stop_project",
  {
    description: "Stop the Godot project currently managed by this server.",
  },
  async () => {
    if (!runningProject) {
      throw new Error("No project has been started by this server.");
    }

    const project = runningProject;
    if (project.status === "running") {
      project.status = "stopping";
      project.child.kill();
      const timeout = setTimeout(() => {
        if (project.status === "stopping") {
          project.child.kill("SIGKILL");
        }
      }, 5_000);
      timeout.unref();
      await project.closed;
      clearTimeout(timeout);
    }

    return textResult(
      `Project ${project.status}: ${project.projectPath}\nExit code: ${project.exitCode ?? "(unavailable)"}`,
    );
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

process.on("exit", () => {
  if (runningProject?.status === "running" || runningProject?.status === "stopping") {
    runningProject.child.kill();
  }
});

process.stdin.on("end", () => {
  if (runningProject?.status === "running") {
    runningProject.status = "stopping";
    runningProject.child.kill();
  }
});
