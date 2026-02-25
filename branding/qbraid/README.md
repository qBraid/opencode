# Codeq by qBraid

Codeq is qBraid's branded version of opencode - the universe's most powerful coding agent for quantum software development.

## Configuration

Codeq is configured by qBraid's platform. The configuration file is placed at:

- **Project-level**: `.codeq/opencode.json` in your project directory
- **Global**: `~/.config/codeq/config.json`

### Example Configuration

```json
{
  "model": "qbraid/claude-sonnet-4-5",
  "provider": {
    "qbraid": {
      "options": {
        "apiKey": "qbr_...",
        "baseURL": "https://account.qbraid.com/api/ai/v1"
      }
    }
  }
}
```

## Available Models

Codeq provides access to the following models through qBraid:

| Model ID                   | Name              | Features                            |
| -------------------------- | ----------------- | ----------------------------------- |
| `qbraid/claude-sonnet-4-5` | Claude 4.5 Sonnet | Reasoning, attachments, tool calls  |
| `qbraid/claude-haiku-4-5`  | Claude 4.5 Haiku  | Fast, attachments, tool calls       |
| `qbraid/gemini-3-flash`    | Gemini 3 Flash    | 1M context, attachments, tool calls |
| `qbraid/grok-4.1-fast`     | Grok 4.1 Fast     | Attachments, tool calls             |

List available models:

```bash
codeq models
```

## Usage

```bash
# Start Codeq TUI
codeq

# Run with a message
codeq run "explain this quantum circuit"

# Start in a specific directory
codeq /path/to/project
```

## Environment Variables

Codeq uses the `CODEQ_` prefix for environment variables:

| Variable                  | Description                                      |
| ------------------------- | ------------------------------------------------ |
| `CODEQ_MODEL`             | Default model to use                              |
| `CODEQ_DISABLE_TELEMETRY` | Disable usage telemetry                           |
| `CODEQ_LOG_LEVEL`         | Log level (DEBUG, INFO, WARN, ERROR)              |
| `QBRAID_API_URL`          | Override qBraid API endpoint (e.g. staging)       |

## Data Storage

Codeq stores data in:

- **Config**: `~/.config/codeq/`
- **Cache**: `~/.cache/codeq/`
- **Data**: `~/.local/share/codeq/`

## Support

For issues with Codeq, contact qBraid support at https://qbraid.com/support
