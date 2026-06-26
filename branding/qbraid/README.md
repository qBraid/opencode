# CodeQ by qBraid

CodeQ is qBraid's branded version of opencode - the universe's most powerful coding agent for quantum software development.

## Configuration

CodeQ is configured by qBraid's platform. The configuration file is placed at:

- **Project-level**: `.codeq/opencode.json` in your project directory
- **Global**: `~/.config/codeq/config.json`

### Example Configuration

```json
{
  "model": "qbraid/gemini-3.5-flash",
  "provider": {
    "qbraid": {
      "options": {
        "apiKey": "qbr_...",
        "baseURL": "https://account-v2.qbraid.com/api/ai/v1"
      }
    }
  }
}
```

## Available Models

CodeQ provides access to the following models through qBraid:

| Model ID                  | Name             | Features                                 |
| ------------------------- | ---------------- | ---------------------------------------- |
| `qbraid/claude-opus-4-8`  | Claude Opus 4.8  | Reasoning, 1M context, attachments, tools |
| `qbraid/claude-sonnet-4-6`| Claude Sonnet 4.6| Reasoning, 1M context, attachments, tools |
| `qbraid/claude-haiku-4-5` | Claude Haiku 4.5 | Fast, reasoning, attachments, tools      |
| `qbraid/gemini-3.1-pro`   | Gemini 3.1 Pro   | Reasoning, 1M context, multimodal, tools |
| `qbraid/gemini-3.5-flash` | Gemini 3.5 Flash | Fast, 1M context, multimodal, tools      |

List available models:

```bash
codeq models
```

## Usage

```bash
# Start CodeQ TUI
codeq

# Run with a message
codeq run "explain this quantum circuit"

# Start in a specific directory
codeq /path/to/project
```

## Environment Variables

CodeQ uses the `CODEQ_` prefix for environment variables:

| Variable                  | Description                          |
| ------------------------- | ------------------------------------ |
| `CODEQ_MODEL`             | Default model to use                 |
| `CODEQ_DISABLE_TELEMETRY` | Disable usage telemetry              |
| `CODEQ_LOG_LEVEL`         | Log level (DEBUG, INFO, WARN, ERROR) |

## Data Storage

CodeQ stores data in:

- **Config**: `~/.config/codeq/`
- **Cache**: `~/.cache/codeq/`
- **Data**: `~/.local/share/codeq/`

## Support

For issues with CodeQ, contact qBraid support at https://qbraid.com/support
