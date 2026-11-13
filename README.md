# Godot DeepSeek MCP

Godot DeepSeek MCP is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets [Cline](https://cline.bot/) use tools for inspecting and controlling Godot projects, while Cline uses the DeepSeek API as its AI provider.

The workflow has two separate connections:

1. **Cline ↔ DeepSeek:** In Cline settings, choose the DeepSeek provider, enter your DeepSeek API key, and select a model. Cline sends model requests directly to DeepSeek.
2. **Cline ↔ this MCP server ↔ Godot:** Add this local server to Cline's MCP configuration. Cline can then call its Godot tools and use the results in the conversation.

**Your DeepSeek API key is configured in Cline, not in this server.** This project does not receive or forward your model prompts or API key. The server only handles local Godot operations.

## Current status

This repository is the starting point for a Cline + DeepSeek workflow for working with Godot projects. The server currently provides:

- `get_godot_version` — reports the installed Godot version.
- `inspect_godot_project` — reads the project name, main scene, and configuration version from `project.godot`. It does not run the project.
- `list_projects` — discovers projects beneath a directory with configurable depth and result limits.
- `launch_editor` — opens the Godot editor for a project.
- `run_project` — runs a project and captures its standard output and errors. A `headless` option is available.
- `get_debug_output` — returns recent output and process status for the project started by this server.
- `stop_project` — stops the project started by this server.

The server manages one running project at a time and keeps a bounded in-memory log buffer. The scene and resource tools in the roadmap are not available yet; they will be added incrementally and tested with Cline and local Godot projects.

## Requirements

- Node.js 20 or newer
- npm
- Godot installed locally
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

To build and launch the server manually during development:

```bash
npm run build
npm start
```

`npm start` launches the MCP server over standard input/output and is intended to be run by an MCP client such as Cline.

## Roadmap

Planned features, broadly following the capabilities of a Godot-focused MCP server:

### Project and runtime workflow

- [x] Get the installed Godot version.
- [x] Inspect basic project metadata.
- [x] Discover and list Godot projects in a directory.
- [ ] Return more detailed project structure and settings.
- [x] Launch the Godot editor for a project.
- [x] Run a project and return its debug output and errors to Cline.
- [x] Stop a project started by the MCP server.

### Scene and resource tools

- [ ] Create scenes with a selected root node type.
- [ ] Add nodes to scenes and configure supported properties.
- [ ] Load textures or sprites into `Sprite2D` nodes.
- [ ] Save scenes and optionally create scene variants.
- [ ] Export 3D scenes as `MeshLibrary` resources for use with `GridMap`.

### Resource identifiers

- [ ] Read resource UIDs for project files.
- [ ] Refresh or update UID references by asking Godot to resave resources (Godot 4.4+).

Features will be added incrementally. The exact tool behavior and supported Godot versions may be refined as they are implemented and tested.

## References

- [Cline: Configure DeepSeek](https://docs.cline.bot/provider-config/deepseek)
- [Cline: MCP servers](https://docs.cline.bot/mcp/mcp-overview)
- [DeepSeek API documentation](https://api-docs.deepseek.com/)
