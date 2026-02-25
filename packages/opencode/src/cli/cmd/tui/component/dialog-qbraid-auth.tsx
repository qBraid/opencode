/**
 * First-run qBraid API key dialog.
 *
 * Shown after telemetry consent on first launch. Prompts the user
 * for a qBraid API key and stores it via the auth API.
 *
 * Exports:
 *  - KV_QBRAID_AUTH_SHOWN: KV key to track whether the dialog has been shown
 *  - DialogQBraidAuth.show(dialog): returns Promise<boolean> (true if key was set)
 */

import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { createSignal, onMount, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"

export const KV_QBRAID_AUTH_SHOWN = "qbraid_auth_shown"

function DialogQBraidAuthContent(props: { onResult: (connected: boolean) => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  let textarea: TextareaRenderable
  const [error, setError] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  useKeyboard((evt) => {
    if (evt.name === "return" && !saving()) {
      submit()
    }
    if (evt.name === "escape") {
      props.onResult(false)
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
  })

  async function submit() {
    const value = textarea.plainText.trim()
    if (!value) {
      props.onResult(false)
      return
    }
    setSaving(true)
    setError("")
    try {
      await sdk.client.auth.set({
        providerID: "qbraid",
        auth: { type: "api", key: value },
      })
      await sdk.client.instance.dispose()
      await sync.bootstrap()
      props.onResult(true)
    } catch (e) {
      setError(String(e))
      setSaving(false)
    }
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Connect qBraid
        </text>
        <box
          paddingLeft={1}
          paddingRight={1}
          onMouseUp={() => props.onResult(false)}
        >
          <text fg={theme.textMuted}>esc to skip</text>
        </box>
      </box>
      <box gap={1}>
        <text fg={theme.textMuted} wrapMode="word">
          Enter your qBraid API key to enable quantum computing features — device
          listing, job submission, credit tracking, and more.
        </text>
        <text fg={theme.text}>
          Get a key at <span style={{ fg: theme.primary }}>https://account.qbraid.com/api-keys</span>
        </text>
        <textarea
          onSubmit={() => submit()}
          height={3}
          keyBindings={[{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => (textarea = val)}
          placeholder="qbraid_api_..."
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
      </box>
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>{saving() ? "saving..." : "submit"}</span>
        </text>
        <text fg={theme.textMuted}>
          {"  "}esc <span style={{ fg: theme.textMuted }}>skip</span>
        </text>
      </box>
    </box>
  )
}

export const DialogQBraidAuth = {
  show(dialog: DialogContext): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      dialog.replace(
        () => <DialogQBraidAuthContent onResult={(connected) => resolve(connected)} />,
        () => resolve(false),
      )
    })
  },
}
