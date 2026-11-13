#!/usr/bin/env node

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MAX_LOG_LINES = 500;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_LINE_BYTES = 64 * 1024;
const GODOT_OPERATION_TIMEOUT_MS = 120_000;
const GODOT_RESULT_PREFIX = "GODOT_MCP_RESULT:";
const IGNORED_PROJECT_DIRECTORIES = new Set([".git", ".godot", "node_modules"]);
const execFileAsync = promisify(execFile);
const godotOperationsScript = join(dirname(fileURLToPath(import.meta.url)), "godot_operations.gd");

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
  status: ManagedProcessStatus;
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

type ManagedProcessStatus = "running" | "stopping" | "stopped" | "exited" | "error";

interface ManagedEditor {
  child: ChildProcess;
  projectPath: string;
  startedAt: string;
  status: ManagedProcessStatus;
  exitCode: number | null;
  closed: Promise<void>;
  resolveClosed: () => void;
}

const server = new McpServer({
  name: "godot-deepseek-mcp",
  version: "0.1.0",
});

let runningProject: RunningProject | undefined;
let managedEditor: ManagedEditor | undefined;
let startingProject = false;

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

function validateResourcePath(resourcePath: string, extensions: string[] = []): string {
  const normalized = resourcePath.replaceAll("\\", "/");
  if (!normalized.startsWith("res://")) {
    throw new Error("Resource paths must be project-relative and start with res://.");
  }

  const relativePath = normalized.slice("res://".length);
  const segments = relativePath.split("/");
  if (
    !relativePath ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Resource path must identify a file inside the Godot project.");
  }
  if (extensions.length > 0) {
    const extension = relativePath.split(".").pop()?.toLowerCase();
    if (!extension || !extensions.includes(extension)) {
      throw new Error(`Resource path must use one of these extensions: ${extensions.join(", ")}.`);
    }
  }

  return normalized;
}

async function runGodotOperation(
  projectPath: string,
  operation: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const directory = await validateProject(projectPath);
  const executable = await findGodotExecutable();
  await access(godotOperationsScript);

  const requestDirectory = await mkdtemp(join(tmpdir(), "godot-deepseek-mcp-"));
  const requestPath = join(requestDirectory, "request.json");
  await writeFile(requestPath, JSON.stringify({ operation, ...args }), "utf8");

  let stdout = "";
  let stderr = "";
  try {
    try {
      const result = await execFileAsync(
        executable,
        [
          "--headless",
          "--path",
          directory,
          "--script",
          godotOperationsScript,
          "--",
          "--request",
          requestPath,
        ],
        {
          cwd: directory,
          maxBuffer: 8 * 1024 * 1024,
          timeout: GODOT_OPERATION_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      stdout = processError.stdout ?? "";
      stderr = processError.stderr ?? "";
      if (!stdout.includes(GODOT_RESULT_PREFIX)) {
        const detail = stderr.trim() || processError.message || "Godot exited without output.";
        throw new Error(`Godot operation "${operation}" failed: ${detail}`);
      }
    }

    const resultLine = stdout
      .split(/\r?\n/)
      .reverse()
      .find((line) => line.startsWith(GODOT_RESULT_PREFIX));
    if (!resultLine) {
      const detail = stderr.trim() || stdout.trim() || "Godot returned no operation result.";
      throw new Error(`Godot operation "${operation}" failed: ${detail}`);
    }

    let response: { success?: boolean; error?: string; data?: unknown };
    try {
      response = JSON.parse(resultLine.slice(GODOT_RESULT_PREFIX.length));
    } catch (error) {
      throw new Error(
        `Godot operation "${operation}" returned invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.success) {
      throw new Error(response.error || `Godot operation "${operation}" failed.`);
    }
    return response.data;
  } finally {
    await rm(requestDirectory, { recursive: true, force: true });
  }
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

function attachEditorProcess(child: ChildProcess, projectPath: string): ManagedEditor {
  let resolveClosed = () => {};
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const editor: ManagedEditor = {
    child,
    projectPath,
    startedAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    closed,
    resolveClosed,
  };

  child.on("error", (error) => {
    editor.status = "error";
    appendLogLineForEditor(editor, `Godot editor process error: ${error.message}`);
    editor.resolveClosed();
  });
  child.on("close", (code) => {
    editor.exitCode = code;
    if (editor.status !== "error") {
      editor.status = editor.status === "stopping" ? "stopped" : "exited";
    }
    editor.resolveClosed();
  });
  return editor;
}

function appendLogLineForEditor(editor: ManagedEditor, message: string): void {
  console.error(`[Godot editor PID ${editor.child.pid ?? "unknown"}] ${message}`);
}

async function stopChildProcess(
  child: ChildProcess,
  closed: Promise<void>,
  markStopping: () => void,
  isStopping: () => boolean,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  markStopping();
  if (!child.kill()) {
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error(`Could not stop process ${child.pid ?? "(unknown PID)"}.`);
    }
    return;
  }

  const timeout = setTimeout(() => {
    if (isStopping()) {
      child.kill("SIGKILL");
    }
  }, 5_000);
  timeout.unref();
  await closed;
  clearTimeout(timeout);
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
  "get_project_info",
  {
    description:
      "Return project settings and a bounded list of project files, excluding generated and hidden directories.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      maxDepth: z.number().int().min(0).max(10).default(6),
      maxFiles: z.number().int().min(1).max(10_000).default(2_000),
    },
  },
  async ({ projectPath, maxDepth, maxFiles }) => {
    const info = await runGodotOperation(projectPath, "get_project_info", {
      max_depth: maxDepth,
      max_files: maxFiles,
    });
    return textResult(JSON.stringify(info, null, 2));
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
  "create_scene",
  {
    description: "Create a new scene with a built-in Godot Node class as its root.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      scenePath: z.string().min(1).describe("New scene path, for example res://scenes/player.tscn."),
      rootType: z.string().min(1).default("Node2D"),
      rootName: z.string().min(1).default("Root"),
      overwrite: z.boolean().default(false),
    },
  },
  async ({ projectPath, scenePath, rootType, rootName, overwrite }) => {
    const safeScenePath = validateResourcePath(scenePath, ["tscn"]);
    const result = await runGodotOperation(projectPath, "create_scene", {
      scene_path: safeScenePath,
      root_type: rootType,
      root_name: rootName,
      overwrite,
    });
    return textResult(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "add_node",
  {
    description:
      "Add a built-in Godot Node to a scene, set supported properties, and save the scene. Vector/color/NodePath/resource property values can use a $type object.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      scenePath: z.string().min(1).describe("Scene path, for example res://scenes/player.tscn."),
      nodeType: z.string().min(1).describe("Built-in Godot Node class, such as Sprite2D."),
      nodeName: z.string().min(1).describe("Name for the new node."),
      parentPath: z.string().default(".").describe("Relative node path to the parent; defaults to the scene root."),
      properties: z.record(z.string(), z.unknown()).default({}),
    },
  },
  async ({ projectPath, scenePath, nodeType, nodeName, parentPath, properties }) => {
    const safeScenePath = validateResourcePath(scenePath, ["tscn"]);
    const result = await runGodotOperation(projectPath, "add_node", {
      scene_path: safeScenePath,
      node_type: nodeType,
      node_name: nodeName,
      parent_path: parentPath,
      properties,
    });
    return textResult(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "load_sprite",
  {
    description: "Load a project texture into a new Sprite2D node in an existing scene.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      scenePath: z.string().min(1).describe("Scene path, for example res://scenes/player.tscn."),
      texturePath: z.string().min(1).describe("Texture path, for example res://sprites/player.png."),
      nodeName: z.string().min(1).default("Sprite2D"),
      parentPath: z.string().default("."),
    },
  },
  async ({ projectPath, scenePath, texturePath, nodeName, parentPath }) => {
    const safeScenePath = validateResourcePath(scenePath, ["tscn"]);
    const safeTexturePath = validateResourcePath(texturePath);
    const result = await runGodotOperation(projectPath, "load_sprite", {
      scene_path: safeScenePath,
      texture_path: safeTexturePath,
      node_name: nodeName,
      parent_path: parentPath,
    });
    return textResult(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "save_scene",
  {
    description:
      "Load and save a scene, optionally to a new .tscn path to create a scene variant without modifying the source.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      scenePath: z.string().min(1).describe("Source scene path."),
      outputPath: z.string().min(1).optional().describe("Optional destination scene path for a variant."),
      overwrite: z.boolean().default(false),
    },
  },
  async ({ projectPath, scenePath, outputPath, overwrite }) => {
    const safeScenePath = validateResourcePath(scenePath, ["tscn"]);
    const safeOutputPath = outputPath ? validateResourcePath(outputPath, ["tscn"]) : undefined;
    const result = await runGodotOperation(projectPath, "save_scene", {
      scene_path: safeScenePath,
      output_path: safeOutputPath,
      overwrite,
    });
    return textResult(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "export_mesh_library",
  {
    description:
      "Export each MeshInstance3D in a 3D scene as a MeshLibrary item suitable for GridMap.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      scenePath: z.string().min(1).describe("Source 3D scene path."),
      outputPath: z.string().min(1).describe("Output .tres or .res path."),
      overwrite: z.boolean().default(false),
    },
  },
  async ({ projectPath, scenePath, outputPath, overwrite }) => {
    const safeScenePath = validateResourcePath(scenePath, ["tscn"]);
    const safeOutputPath = validateResourcePath(outputPath, ["tres", "res"]);
    const result = await runGodotOperation(projectPath, "export_mesh_library", {
      scene_path: safeScenePath,
      output_path: safeOutputPath,
      overwrite,
    });
    return textResult(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "get_uid",
  {
    description: "Return the Godot UID for a project resource (Godot 4.4 or newer).",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      resourcePath: z.string().min(1).describe("Project-relative path such as res://scenes/player.tscn."),
    },
  },
  async ({ projectPath, resourcePath }) => {
    const safeResourcePath = validateResourcePath(resourcePath);
    const uid = await runGodotOperation(projectPath, "get_uid", {
      resource_path: safeResourcePath,
    });
    return textResult(JSON.stringify(uid, null, 2));
  },
);

server.registerTool(
  "update_project_uids",
  {
    description:
      "Scan project scenes/resources for UID refresh candidates. Defaults to a safe dry run; set apply=true to resave .tscn/.tres/.res/.scn files.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
      apply: z.boolean().default(false).describe("Must be true to write changes to project resources."),
    },
  },
  async ({ projectPath, apply }) => {
    const result = await runGodotOperation(projectPath, "update_project_uids", {
      apply,
    });
    return textResult(JSON.stringify(result, null, 2));
  },
);

server.registerTool(
  "launch_editor",
  {
    description:
      "Launch and track the Godot editor for a validated project directory. Use get_editor_status and stop_editor to manage the launched process.",
    inputSchema: {
      projectPath: z.string().min(1).describe("Path to the Godot project folder."),
    },
  },
  async ({ projectPath }) => {
    if (managedEditor?.status === "running" || managedEditor?.status === "stopping") {
      if (managedEditor.projectPath === resolve(projectPath)) {
        return textResult(
          `Godot editor is already running for ${managedEditor.projectPath} (PID ${managedEditor.child.pid ?? "unknown"}).`,
        );
      }
      throw new Error(
        `Godot editor is already running for ${managedEditor.projectPath}. Stop it before opening another project.`,
      );
    }

    const directory = await validateProject(projectPath);
    const executable = await findGodotExecutable();
    const child = spawn(executable, ["--editor", "--path", directory], {
      stdio: "ignore",
      windowsHide: true,
    });
    const editor = attachEditorProcess(child, directory);
    managedEditor = editor;

    await new Promise<void>((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    }).catch((error: unknown) => {
      editor.status = "error";
      editor.resolveClosed();
      throw new Error(
        `Could not launch Godot editor: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return textResult(
      `Godot editor launched for ${directory} (PID ${child.pid ?? "unknown"}). Use get_editor_status or stop_editor to manage it.`,
    );
  },
);

server.registerTool(
  "get_editor_status",
  {
    description: "Return the status of the Godot editor process started by this server.",
  },
  async () => {
    if (!managedEditor) {
      throw new Error("No Godot editor has been launched by this server.");
    }

    return textResult(
      [
        `Project: ${managedEditor.projectPath}`,
        `Status: ${managedEditor.status}`,
        `PID: ${managedEditor.child.pid ?? "unknown"}`,
        `Started: ${managedEditor.startedAt}`,
        `Exit code: ${managedEditor.exitCode ?? "(still running or unavailable)"}`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "stop_editor",
  {
    description: "Stop the Godot editor process launched and managed by this server.",
  },
  async () => {
    if (!managedEditor) {
      throw new Error("No Godot editor has been launched by this server.");
    }

    const editor = managedEditor;
    await stopChildProcess(
      editor.child,
      editor.closed,
      () => {
        editor.status = "stopping";
      },
      () => editor.status === "stopping",
    );
    return textResult(
      `Godot editor ${editor.status}: ${editor.projectPath}\nExit code: ${editor.exitCode ?? "(unavailable)"}`,
    );
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
    if (
      startingProject ||
      runningProject?.status === "running" ||
      runningProject?.status === "stopping"
    ) {
      throw new Error(
        startingProject
          ? "A project is already starting. Wait for it to launch before starting another."
          : `A project is already ${runningProject?.status}: ${runningProject?.projectPath}. Stop it before starting another.`,
      );
    }

    startingProject = true;
    let project: RunningProject | undefined;
    try {
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
      project = attachProjectProcess(child, directory);
      runningProject = project;

      await new Promise<void>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("spawn", resolvePromise);
      });

      return textResult(
        `Project started: ${directory}\nPID: ${child.pid ?? "unknown"}\nHeadless: ${headless}\nUse get_debug_output to read logs and stop_project to stop it.`,
      );
    } catch (error) {
      if (project?.status === "running" && !project.child.pid) {
        project.status = "error";
        project.resolveClosed();
      }
      throw new Error(
        `Could not launch Godot project: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      startingProject = false;
    }
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
      await stopChildProcess(
        project.child,
        project.closed,
        () => {
          project.status = "stopping";
        },
        () => project.status === "stopping",
      );
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
  if (managedEditor?.status === "running" || managedEditor?.status === "stopping") {
    managedEditor.child.kill();
  }
});

process.stdin.on("end", () => {
  if (runningProject?.status === "running") {
    runningProject.status = "stopping";
    runningProject.child.kill();
  }
  if (managedEditor?.status === "running") {
    managedEditor.status = "stopping";
    managedEditor.child.kill();
  }
});
