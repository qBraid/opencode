# qBraid Fork Rationale: Why Source Modifications Are Required

This document explains which qBraid/Codeq features require source-level modifications
to OpenCode and which could theoretically be implemented via the existing plugin/MCP
extension points. It serves as a reference for upstream discussions and future
architecture decisions.

## Extension Points Available in OpenCode

OpenCode provides three extension mechanisms:

| Mechanism | Capabilities |
|-----------|-------------|
| **Plugins** | Server-side hooks for auth, chat pipeline (messages, params, headers, system prompt), tool registration, event listening, permission overrides, shell env injection. Plugins are async functions loaded from npm packages or local `.ts`/`.js` files. |
| **MCP servers** | External processes providing tools, resources, and prompts via the Model Context Protocol. Auto-connected from config. Tools appear alongside built-in tools. |
| **Config** | Keybinds, themes, agents (markdown), slash commands (markdown), skills, permissions, MCP server definitions, diff style, scroll behavior. |

### Key limitation

The plugin system is a **server-side hooks API** for the LLM conversation pipeline.
It has **zero TUI extensibility surface**. The TUI is a self-contained SolidJS
application with a hardcoded component tree. There is no mechanism for plugins or MCP
servers to inject sidebar sections, dialogs, footer elements, spinner styles, or any
other visual components.

## Feature-by-Feature Analysis

### Features that COULD be plugins or MCP

| Feature | Mechanism | Notes |
|---------|-----------|-------|
| Quantum tools (list devices, submit job, get result, cancel, estimate cost, list jobs) | MCP server | An MCP server wrapping the qBraid quantum API would provide the same 6 tools. Config-only, zero source changes. |
| Chat header injection | Plugin `chat.headers` hook | Injecting `X-API-Key` or other headers into LLM requests. |
| System prompt customization | Plugin `experimental.chat.system.transform` hook | Adding quantum-specific instructions to the system prompt. |
| Event listening for analytics | Plugin `event` hook | Plugins receive all bus events and could forward them to an analytics backend. |
| Provider auth flow (API key) | Plugin `auth` hook | The `auth` hook can define API key and OAuth flows for a provider. The CodexAuthPlugin is an example. |

### Features that REQUIRE source modifications

#### 1. Quantum Sidebar Dashboard

**Files**: `quantum-status.tsx`, `sidebar.tsx`, `quantum/state.ts`, `quantum/poller.ts`, `quantum/client.ts`

The sidebar component tree is hardcoded in `sidebar.tsx`. The section order
(Title, Context, **qBraid**, MCP, LSP, Todo, Modified Files) is defined in JSX
with no injection point. `QuantumSidebarSection` is imported and rendered directly.

There is no plugin hook for adding sidebar sections. The `command.register()` API
adds items to the command palette, not the sidebar. MCP servers appear in the sidebar
only as connection status indicators (colored dot + name + status text) -- they cannot
provide custom widgets.

The quantum sidebar also requires:
- A background **scheduler task** (`quantum.poll`, 15s interval) -- `Scheduler.register()`
  is not exposed to plugins
- A custom **bus event** (`quantum.state.updated`) -- `BusEvent.define()` is a
  compile-time operation; plugins can listen but cannot publish new event types
- An **SSE event pipeline** to deliver state updates from the worker thread to the
  main TUI thread

#### 2. Telemetry System and Consent Dialog

**Files**: `telemetry/index.ts`, `telemetry/integration.ts`, `telemetry/types.ts`, `dialog-telemetry-consent.tsx`, `app.tsx`

The telemetry system subscribes to bus events server-side and forwards metrics to the
qBraid analytics endpoint. While a plugin's `event` hook can listen to events, it
cannot:
- Ship a consent dialog (dialogs are hardcoded in `app.tsx`)
- Control startup sequencing (consent -> auth -> provider connect)
- Persist consent state to the KV store from the server side
- Conditionally enable/disable itself based on user tier

#### 3. qBraid Auth Startup Dialog

**Files**: `dialog-qbraid-auth.tsx`, `app.tsx`

The first-run dialog that prompts users for their qBraid API key requires a TUI dialog
component. Plugin `auth` hooks can define auth *methods* (API key, OAuth) that appear
in the `/connect` flow, but they cannot trigger a dialog at startup or control the
dialog sequencing order.

#### 4. Provider SDK (`@ai-sdk/qbraid`)

**Files**: `provider/sdk/qbraid/index.ts`, `provider/provider.ts`

The qBraid provider extends `@ai-sdk/openai-compatible` with a custom default endpoint
(`QBRAID_DEFAULT_API_URL`), env var override (`QBRAID_API_URL`), and registration in
the `BUNDLED_PROVIDERS` map. Plugins can modify models within an existing provider via
the `auth` hook, but they cannot:
- Register new entries in `BUNDLED_PROVIDERS`
- Add new provider factory functions to `getSDK()`
- Set `includeUsage: true` for specific providers (line-level logic in `provider.ts`)

#### 5. Interference Spinner Animation

**Files**: `spinner.ts`, `prompt/index.tsx`

The spinner style is hardcoded in `prompt/index.tsx` using `createFrames()` and
`createColors()` with fixed parameters. There is no configuration option or plugin
hook to customize spinner appearance.

#### 6. SSE Event Pipeline Fix

**Files**: `context/sdk.tsx`

The fix that moved RPC event listener registration from `onMount` to the init phase
is core infrastructure. The timing race between worker-thread event emission and
main-thread listener registration cannot be addressed externally.

#### 7. Branding

**Files**: `branding/apply.ts`, `branding/qbraid/brand.json`, hundreds of source files

The `opencode` -> `codeq` rename touches package names, binary names, config paths,
data directories, system prompts, and user-facing strings across 274 files. This is a
build-system transformation that is fundamentally source-level.

## Summary

```
Source modification required:
  - TUI components (sidebar, dialogs, footer)     -- no plugin UI API
  - Bus event definitions                          -- compile-time only
  - Scheduler tasks                                -- not exposed to plugins
  - Provider SDK registration                      -- internal map
  - Spinner/animation customization                -- hardcoded
  - SSE/event pipeline infrastructure              -- core plumbing
  - Branding                                       -- build system
  - Startup dialog sequencing                      -- hardcoded in app.tsx

Could be external (plugin or MCP):
  - Quantum tools (6 tools)                        -- MCP server
  - Chat hooks (headers, system prompt)            -- plugin hooks
  - Event listening for analytics                  -- plugin event hook
  - Provider auth flow                             -- plugin auth hook
```

Roughly **30% of the quantum work** (the tools themselves) could be an MCP server.
The remaining **70%** (UI, infrastructure, branding) requires source changes because
OpenCode's TUI has no component injection mechanism.

## Recommendations for Upstream

If OpenCode added the following extension points, a significant portion of the
qBraid customizations could move to plugins:

1. **Sidebar widget hook** -- allow plugins to register sidebar section components
2. **Dialog hook** -- allow plugins to show dialogs and control startup sequencing
3. **Scheduler hook** -- expose `Scheduler.register()` to plugins
4. **Bus publish hook** -- allow plugins to define and publish custom event types
5. **Provider registration hook** -- allow plugins to register new provider SDKs
6. **Spinner/theme hook** -- allow config-level spinner style selection
