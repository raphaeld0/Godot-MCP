# Godot DeepSeek MCP

Godot DeepSeek MCP is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets [Cline](https://cline.bot/) inspect and control Godot projects, while Cline uses the DeepSeek API as its AI provider.

The workflow has two separate connections:

1. **Cline ↔ DeepSeek:** In Cline settings, choose the DeepSeek provider, enter your DeepSeek API key, and select a model. Cline sends model requests directly to DeepSeek.
2. **Cline ↔ this MCP server ↔ Godot:** Add this local server to Cline's MCP configuration. Cline can then call its Godot tools and use the results in the conversation.

**Your DeepSeek API key is configured in Cline, not in this server.** This project does not receive or forward your model prompts or API key. The server only handles local Godot operations.

## Current status

The server currently provides:

- `get_godot_version` — reports the installed Godot version.
- `inspect_godot_project` — reads the project name, main scene, and configuration version from `project.godot`. It does not run the project.
- `list_projects` — discovers projects beneath a directory with configurable depth and result limits.
- `get_project_info` — returns project settings and a bounded list of project files.
- `launch_editor` — opens the Godot editor for a project.
- `run_project` — runs a project and captures its standard output and errors. A `headless` option is available.
- `get_debug_output` — returns recent output and process status for the project started by this server.
- `stop_project` — stops the project started by this server.
- `create_scene` — creates a scene with a built-in Godot node as its root.
- `add_node` — adds a built-in node to a scene, sets supported properties, and saves the scene.
- `load_sprite` — adds a `Sprite2D` node with a project texture to a scene.
- `save_scene` — saves a scene or writes a copy to a new path as a variant.
- `export_mesh_library` — exports mesh instances and supported static-body collision shapes to a `MeshLibrary`.
- `get_uid` — reads a resource UID.
- `update_project_uids` — scans scene and resource files, then can resave them to refresh references.

The server manages one running project at a time and keeps a bounded in-memory log buffer. Scene-writing and UID tools only accept project-relative `res://` paths. New scenes and MeshLibraries are not overwritten unless `overwrite=true`. UID refresh is a dry run by default; review its candidate list before calling it with `apply=true`.

The scene and UID operations use a bundled GDScript helper and have been designed for Godot 4.4 or newer. Run the tests and verify engine-dependent operations in a real Godot installation before using them on important projects.

## Requirements

- Node.js 20 or newer
- npm
- Godot 4.4 or newer installed locally
- Cline for VS Code, configured with a DeepSeek API key

## Configure DeepSeek in Cline

1. Open the Cline panel in VS Code and click its **Settings** icon.
2. Set **API Provider** to **DeepSeek**.
3. Enter your key in **DeepSeek API Key**.
4. Choose an available model in the **Model** dropdown.

Create an API key in the [DeepSeek Platform](https://platform.deepseek.com/api_keys). Keep it in Cline's provider settings; do not paste it into chat or commit it to this repository.

## Build the MCP server

From this repository's directory, run:

```powershell
npm install
npm run build
```

Set `GODOT_PATH` if Godot is not available on your `PATH`. It should point to the executable, for example:

```text
C:\Path\To\Godot\Godot_v4.4-stable_win64.exe
```

## Connect the MCP server to Cline

In VS Code, open Cline's **MCP Servers** view, choose **Configure**, then open the MCP settings JSON. Add a server entry, replacing the example paths with the actual locations on your computer:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["C:\\Path\\To\\Godot-MCP\\dist\\index.js"],
      "env": {
        "GODOT_PATH": "C:\\Path\\To\\Godot\\Godot.exe"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

If Godot is already available on `PATH`, you can omit the `env` section. Save the settings and restart or refresh the server in Cline. The server uses standard input/output for MCP messages; diagnostic errors are written to standard error. Keep `autoApprove` empty unless you explicitly want to approve tools automatically.

## Try it

Once the MCP server is connected, its tools should appear in Cline. For example, ask Cline to find Godot projects in a directory, open the editor, or run a project and report its errors. After starting a project, use `get_debug_output` to inspect its logs and `stop_project` to stop it.

The first runtime version runs one project at a time. Its recent output is kept in memory (up to 500 lines / 512 KiB) and is cleared when another project is started or the MCP server restarts.

For scene operations, use paths such as `res://scenes/player.tscn` and `res://sprites/player.png`. Node property values support JSON values and typed objects for common Godot types:

```json
{
  "position": { "$type": "Vector2", "x": 120, "y": 80 },
  "modulate": { "$type": "Color", "r": 1, "g": 1, "b": 1, "a": 1 },
  "texture": { "$type": "Resource", "path": "res://sprites/player.png" }
}
```

`update_project_uids` initially returns the files it would resave without writing project resources. Set `apply=true` only after reviewing that list; the apply action resaves `.tscn`, `.tres`, `.res`, and `.scn` files.

To build and launch the server manually during development:

```bash
npm run build
npm start
```

`npm start` launches the MCP server over standard input/output and is intended to be run by an MCP client such as Cline.

Run the MCP tests with:

```powershell
npm test
```

Engine integration tests are skipped unless `GODOT_TEST_PATH` points to a Godot 4 executable. For example, in PowerShell:

```powershell
$env:GODOT_TEST_PATH = "C:\Path\To\Godot\Godot_v4.4-stable_win64_console.exe"
npm test
```

## Roadmap

The first project/runtime and scene/resource tools are implemented. The remaining work is to test them across Godot versions and broaden project inspection and resource conversion support.

### Project and runtime workflow

- [x] Get the installed Godot version.
- [x] Inspect basic project metadata.
- [x] Discover and list Godot projects in a directory.
- [x] Return more detailed project structure and settings.
- [x] Launch the Godot editor for a project.
- [x] Run a project and return its debug output and errors to Cline.
- [x] Stop a project started by the MCP server.

### Scene and resource tools

- [x] Create scenes with a selected root node type.
- [x] Add nodes to scenes and configure supported properties.
- [x] Load textures or sprites into `Sprite2D` nodes.
- [x] Save scenes and optionally create scene variants.
- [x] Export 3D scenes as `MeshLibrary` resources for use with `GridMap`, including static-body collisions when present.

### Resource identifiers

- [x] Read resource UIDs for project files (Godot 4.4+).
- [x] Preview and optionally refresh resource references by resaving scene/resource files (Godot 4.4+).

The engine integration suite has been run against Godot 4.4.1 on Windows. The roadmap describes implemented tool coverage; other Godot versions and project configurations may still need additional validation.

## References

- [Cline: Configure DeepSeek](https://docs.cline.bot/provider-config/deepseek)
- [Cline: MCP servers](https://docs.cline.bot/mcp/mcp-overview)
- [DeepSeek API documentation](https://api-docs.deepseek.com/)
