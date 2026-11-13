import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
    "list_projects",
    "launch_editor",
    "run_project",
    "get_debug_output",
    "stop_project",
  ]);
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
