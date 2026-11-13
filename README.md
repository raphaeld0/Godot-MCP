# Godot DeepSeek MCP

Godot DeepSeek MCP is a local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets [Cline](https://cline.bot/) use tools for inspecting and controlling Godot projects, while Cline uses the DeepSeek API as its AI provider.

The workflow has two separate connections:

1. **Cline ↔ DeepSeek:** In Cline settings, choose the DeepSeek provider, enter your DeepSeek API key, and select a model. Cline sends model requests directly to DeepSeek.
2. **Cline ↔ this MCP server ↔ Godot:** Add this local server to Cline's MCP configuration. Cline can then call its Godot tools and use the results in the conversation.

**Your DeepSeek API key is configured in Cline, not in this server.** This project does not receive or forward your model prompts or API key. The server only handles local Godot operations.

## Current status

This is an early scaffold. The server currently provides:

- `get_godot_version` — reports the installed Godot version.
- `inspect_godot_project` — reads the project name, main scene, and configuration version from `project.godot`. It does not run the project.

Running projects, collecting their output, and stopping them through Cline are planned next steps.

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

Once the MCP server is connected, its tools should appear in Cline. For example, ask Cline to check the local Godot version or inspect a project folder containing `project.godot`.

To build and launch the server manually during development:

```bash
npm run build
npm start
```

`npm start` launches the MCP server over standard input/output and is intended to be run by an MCP client such as Cline.

## Roadmap

- Run a Godot project and return its output to Cline.
- Stop a project started by the server.
- Add project discovery and more detailed project inspection.
- Consider scene editing tools after the run-and-debug workflow is established.

## References

- [Cline: Configure DeepSeek](https://docs.cline.bot/provider-config/deepseek)
- [Cline: MCP servers](https://docs.cline.bot/mcp/mcp-overview)
- [DeepSeek API documentation](https://api-docs.deepseek.com/)
