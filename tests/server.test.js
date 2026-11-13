import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let client;
let projectDirectory;
let ignoredProjectDirectory;
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(join(os.tmpdir(), "godot-deepseek-mcp-"));
  projectDirectory = join(temporaryDirectory, "sample-project");
  ignoredProjectDirectory = join(temporaryDirectory, ".godot", "ignored-project");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(ignoredProjectDirectory, { recursive: true });

  const projectFile = [
    "config_version=5",
    "",
    '[application]',
    'config/name="Sample Project"',
    'run/main_scene="res://main.tscn"',
    "",
  ].join("\n");
  await writeFile(join(projectDirectory, "project.godot"), projectFile);
  await writeFile(join(ignoredProjectDirectory, "project.godot"), projectFile);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: { ...process.env, GODOT_PATH: process.execPath },
    stderr: "pipe",
  });
  client = new Client({ name: "godot-deepseek-mcp-tests", version: "0.1.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("registers the Godot project and runtime tools", async () => {
  const response = await client.listTools();
  const names = response.tools.map((tool) => tool.name);

  assert.deepEqual(names, [
    "get_godot_version",
    "inspect_godot_project",
    "get_project_info",
    "list_projects",
    "create_scene",
    "add_node",
    "load_sprite",
    "save_scene",
    "export_mesh_library",
    "get_uid",
    "update_project_uids",
    "launch_editor",
    "get_editor_status",
    "stop_editor",
    "run_project",
    "get_debug_output",
    "stop_project",
  ]);
});

test("build packages the bundled Godot operations script", async () => {
  await access(resolve("dist/godot_operations.gd"));
});

test("inspects project metadata from project.godot", async () => {
  const response = await client.callTool({
    name: "inspect_godot_project",
    arguments: { projectPath: projectDirectory },
  });
  const result = response.content[0];

  assert.equal(result.type, "text");
  assert.match(result.text, /Project: Sample Project/);
  assert.match(result.text, /Main scene: res:\/\/main\.tscn/);
  assert.match(result.text, /Config version: 5/);
});

test("discovers projects without traversing generated hidden directories", async () => {
  const response = await client.callTool({
    name: "list_projects",
    arguments: { directory: temporaryDirectory },
  });
  const result = response.content[0];

  assert.equal(result.type, "text");
  const projects = JSON.parse(result.text);
  assert.equal(projects.count, 1);
  assert.equal(projects.projects[0].name, "Sample Project");
  assert.equal(projects.projects[0].path, projectDirectory);
});

test("reports invalid project paths as tool errors", async () => {
  const response = await client.callTool({
    name: "inspect_godot_project",
    arguments: { projectPath: join(temporaryDirectory, "missing-project") },
  });

  assert.equal(response.isError, true);
});

test("reports editor status and stop errors when no editor was launched", async () => {
  const status = await client.callTool({ name: "get_editor_status", arguments: {} });
  const stop = await client.callTool({ name: "stop_editor", arguments: {} });

  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /No Godot editor has been launched/);
  assert.equal(stop.isError, true);
  assert.match(stop.content[0].text, /No Godot editor has been launched/);
});

test("rejects scene paths that can escape the Godot project", async () => {
  const response = await client.callTool({
    name: "create_scene",
    arguments: {
      projectPath: projectDirectory,
      scenePath: "res://../outside.tscn",
    },
  });

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /inside the Godot project/);
});

test("UID resaving is exposed with an explicit dry-run default", async () => {
  const toolsResponse = await client.listTools();
  const tool = toolsResponse.tools.find((candidate) => candidate.name === "update_project_uids");
  assert.ok(tool);
  assert.match(tool.description, /safe dry run/);

  const invalidPath = await client.callTool({
    name: "get_uid",
    arguments: {
      projectPath: projectDirectory,
      resourcePath: "res://../outside.tscn",
    },
  });
  assert.equal(invalidPath.isError, true);
});

test("captures process output and exit status for a launched project", async () => {
  const startResponse = await client.callTool({
    name: "run_project",
    arguments: { projectPath: projectDirectory },
  });

  assert.equal(startResponse.isError, undefined);
  assert.match(startResponse.content[0].text, /Project started:/);

  let outputResponse;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    outputResponse = await client.callTool({
      name: "get_debug_output",
      arguments: {},
    });
    if (outputResponse.content[0].text.includes("Status: exited")) {
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }

  assert.match(outputResponse.content[0].text, /Status: exited/);
  assert.match(outputResponse.content[0].text, /\[stderr\]/);
  assert.match(outputResponse.content[0].text, /bad option|unknown option/i);
});
