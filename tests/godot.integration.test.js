import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import os from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const godotExecutable = process.env.GODOT_TEST_PATH;
let client;
let projectDirectory;
let temporaryDirectory;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const checksumInput = Buffer.concat([typeBuffer, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(checksumInput), 8 + data.length);
  return chunk;
}

function createPixelPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

before(async () => {
  if (!godotExecutable) {
    return;
  }
  temporaryDirectory = await mkdtemp(join(os.tmpdir(), "godot-mcp-engine-test-"));
  projectDirectory = join(temporaryDirectory, "sample-project");
  await mkdir(join(projectDirectory, "scenes"), { recursive: true });

  await writeFile(
    join(projectDirectory, "project.godot"),
    [
      "config_version=5",
      "",
      "[application]",
      'config/name="MCP Engine Test"',
      'run/main_scene="res://scenes/main.tscn"',
      "",
      "[rendering]",
      'renderer/rendering_method="gl_compatibility"',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(projectDirectory, "scenes", "main.tscn"),
    '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n',
  );
  await writeFile(
    join(projectDirectory, "sphere.tres"),
    '[gd_resource type="SphereMesh" format=3]\n\n[resource]\n',
  );
  await writeFile(
    join(projectDirectory, "sphere_shape.tres"),
    '[gd_resource type="SphereShape3D" format=3]\n\n[resource]\n',
  );
  await writeFile(join(projectDirectory, "pixel.png"), createPixelPng());

  execFileSync(
    godotExecutable,
    ["--headless", "--editor", "--path", projectDirectory, "--quit"],
    { timeout: 60_000, windowsHide: true },
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: { ...process.env, GODOT_PATH: godotExecutable },
    stderr: "pipe",
  });
  client = new Client({ name: "godot-engine-integration", version: "0.1.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Godot engine: inspects project settings and file structure", { skip: !godotExecutable }, async () => {
  const version = await client.callTool({ name: "get_godot_version", arguments: {} });
  assert.equal(version.isError, undefined, version.content[0]?.text);
  assert.match(version.content[0].text, /^4\.4\.1/);

  const response = await client.callTool({
    name: "get_project_info",
    arguments: { projectPath: projectDirectory },
  });
  assert.equal(response.isError, undefined, response.content[0]?.text);
  const info = JSON.parse(response.content[0].text);
  assert.equal(info.settings["application/config/name"], '"MCP Engine Test"');
  assert.equal(info.settings["rendering/renderer/rendering_method"], '"gl_compatibility"');
  assert.ok(info.files.includes("res://scenes/main.tscn"));
});

test("Godot engine: creates, edits, saves, and variants scenes", { skip: !godotExecutable }, async () => {
  const scenePath = "res://scenes/player.tscn";
  const create = await client.callTool({
    name: "create_scene",
    arguments: { projectPath: projectDirectory, scenePath, rootType: "Node2D", rootName: "Player" },
  });
  assert.equal(create.isError, undefined, create.content[0]?.text);

  const add = await client.callTool({
    name: "add_node",
    arguments: {
      projectPath: projectDirectory,
      scenePath,
      nodeType: "Sprite2D",
      nodeName: "Body",
      properties: { position: { $type: "Vector2", x: 12, y: 34 } },
    },
  });
  assert.equal(add.isError, undefined, add.content[0]?.text);

  const invalidProperty = await client.callTool({
    name: "add_node",
    arguments: {
      projectPath: projectDirectory,
      scenePath,
      nodeType: "Sprite2D",
      nodeName: "Invalid",
      properties: { position: { $type: "Color", r: 1, g: 0, b: 0, a: 1 } },
    },
  });
  assert.equal(invalidProperty.isError, true);
  assert.match(invalidProperty.content[0].text, /expects Vector2 but received Color/);

  const sprite = await client.callTool({
    name: "load_sprite",
    arguments: {
      projectPath: projectDirectory,
      scenePath,
      texturePath: "res://pixel.png",
      nodeName: "Icon",
    },
  });
  assert.equal(sprite.isError, undefined, sprite.content[0]?.text);

  const typedNode = await client.callTool({
    name: "add_node",
    arguments: {
      projectPath: projectDirectory,
      scenePath,
      nodeType: "Line2D",
      nodeName: "Path",
      properties: {
        points: {
          $type: "PackedVector2Array",
          values: [
            { $type: "Vector2", x: 1, y: 2 },
            { $type: "Vector2", x: 3, y: 4 },
          ],
        },
        width: 3,
      },
    },
  });
  assert.equal(typedNode.isError, undefined, typedNode.content[0]?.text);

  const variant = await client.callTool({
    name: "save_scene",
    arguments: {
      projectPath: projectDirectory,
      scenePath,
      outputPath: "res://scenes/player_variant.tscn",
    },
  });
  assert.equal(variant.isError, undefined, variant.content[0]?.text);
  await access(join(projectDirectory, "scenes", "player_variant.tscn"));
});

test("Godot engine: exports mesh instances with collision shapes to a MeshLibrary", { skip: !godotExecutable }, async () => {
  const scenePath = "res://scenes/tile.tscn";
  assert.equal(
    (
      await client.callTool({
        name: "create_scene",
        arguments: { projectPath: projectDirectory, scenePath, rootType: "Node3D", rootName: "Tile" },
      })
    ).isError,
    undefined,
  );
  assert.equal(
    (
      await client.callTool({
        name: "add_node",
        arguments: {
          projectPath: projectDirectory,
          scenePath,
          nodeType: "Node3D",
          nodeName: "TransformProbe",
          properties: {
            transform: {
              $type: "Transform3D",
              basis: {
                $type: "Basis",
                x: { $type: "Vector3", x: 1, y: 0, z: 0 },
                y: { $type: "Vector3", x: 0, y: 1, z: 0 },
                z: { $type: "Vector3", x: 0, y: 0, z: 1 },
              },
              origin: { $type: "Vector3", x: 5, y: 6, z: 7 },
            },
          },
        },
      })
    ).isError,
    undefined,
  );
  assert.equal(
    (
      await client.callTool({
        name: "add_node",
        arguments: {
          projectPath: projectDirectory,
          scenePath,
          nodeType: "StaticBody3D",
          nodeName: "Body",
        },
      })
    ).isError,
    undefined,
  );
  assert.equal(
    (
      await client.callTool({
        name: "add_node",
        arguments: {
          projectPath: projectDirectory,
          scenePath,
          nodeType: "MeshInstance3D",
          nodeName: "Mesh",
          parentPath: "Body",
          properties: { mesh: { $type: "Resource", path: "res://sphere.tres" } },
        },
      })
    ).isError,
    undefined,
  );
  assert.equal(
    (
      await client.callTool({
        name: "add_node",
        arguments: {
          projectPath: projectDirectory,
          scenePath,
          nodeType: "CollisionShape3D",
          nodeName: "Collision",
          parentPath: "Body",
          properties: { shape: { $type: "Resource", path: "res://sphere_shape.tres" } },
        },
      })
    ).isError,
    undefined,
  );

  const exportResult = await client.callTool({
    name: "export_mesh_library",
    arguments: {
      projectPath: projectDirectory,
      scenePath,
      outputPath: "res://tiles.tres",
    },
  });
  assert.equal(exportResult.isError, undefined, exportResult.content[0]?.text);
  await access(join(projectDirectory, "tiles.tres"));
  const verifier = join(projectDirectory, "verify_mesh_library.gd");
  await writeFile(
    verifier,
    [
      "extends SceneTree",
      "func _initialize():",
      '    var library = load("res://tiles.tres") as MeshLibrary',
      "    var item_id = library.get_item_list()[0]",
      '    print("GODOT_MESH_SHAPES:" + str(library.get_item_shapes(item_id).size()))',
      "    quit()",
      "",
    ].join("\n"),
  );
  const verificationOutput = execFileSync(
    godotExecutable,
    ["--headless", "--path", projectDirectory, "--script", verifier],
    { encoding: "utf8", timeout: 60_000, windowsHide: true },
  );
  assert.match(verificationOutput, /GODOT_MESH_SHAPES:2/);
});

test("Godot engine: reads UIDs and previews a UID refresh without writing", { skip: !godotExecutable }, async () => {
  const uid = await client.callTool({
    name: "get_uid",
    arguments: { projectPath: projectDirectory, resourcePath: "res://scenes/main.tscn" },
  });
  assert.equal(uid.isError, undefined);
  assert.equal(JSON.parse(uid.content[0].text).resource_path, "res://scenes/main.tscn");

  const refresh = await client.callTool({
    name: "update_project_uids",
    arguments: { projectPath: projectDirectory },
  });
  assert.equal(refresh.isError, undefined);
  const dryRun = JSON.parse(refresh.content[0].text);
  assert.equal(dryRun.dry_run, true);
  assert.ok(dryRun.candidate_count > 0);

  const applied = await client.callTool({
    name: "update_project_uids",
    arguments: { projectPath: projectDirectory, apply: true },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  const result = JSON.parse(applied.content[0].text);
  assert.equal(result.dry_run, false);
  assert.ok(result.updated_count > 0);
});

test("Godot engine: runs and stops a headless project", { skip: !godotExecutable }, async () => {
  const start = await client.callTool({
    name: "run_project",
    arguments: { projectPath: projectDirectory, headless: true },
  });
  assert.equal(start.isError, undefined, start.content[0]?.text);

  const output = await client.callTool({
    name: "get_debug_output",
    arguments: { maxLines: 20 },
  });
  assert.equal(output.isError, undefined, output.content[0]?.text);
  assert.match(output.content[0].text, /Status: running/);

  const stop = await client.callTool({ name: "stop_project", arguments: {} });
  assert.equal(stop.isError, undefined, stop.content[0]?.text);
  assert.match(stop.content[0].text, /Project stopped/);
});

test("Godot engine: tracks and stops an editor process", { skip: !godotExecutable }, async () => {
  const start = await client.callTool({
    name: "launch_editor",
    arguments: { projectPath: projectDirectory },
  });
  assert.equal(start.isError, undefined, start.content[0]?.text);

  const status = await client.callTool({ name: "get_editor_status", arguments: {} });
  assert.equal(status.isError, undefined, status.content[0]?.text);
  assert.match(status.content[0].text, /Project: .*sample-project/);
  assert.match(status.content[0].text, /Status: running/);

  const stop = await client.callTool({ name: "stop_editor", arguments: {} });
  assert.equal(stop.isError, undefined, stop.content[0]?.text);
  assert.match(stop.content[0].text, /Godot editor stopped/);
});
