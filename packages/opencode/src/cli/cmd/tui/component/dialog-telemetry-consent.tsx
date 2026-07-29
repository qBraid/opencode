/**
 * First-run telemetry consent dialog.
 *
 * - Free-tier users: informational only — telemetry is required, single "I Understand" button.
 * - Paid/unknown users: genuine opt-in with "Enable" / "No Thanks" buttons.
 *
 * The consent choice is persisted to the KV store and loaded into the
 * Telemetry consent module on startup.
 */

import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useKV } from "@tui/context/kv"
import { createStore } from "solid-js/store"
import { For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { Telemetry } from "@/telemetry"

/** KV keys used by the consent dialog */
export const KV_TELEMETRY_CONSENT_SHOWN = "telemetry_consent_shown"
export const KV_TELEMETRY_ENABLED = "telemetry_enabled"

type Tier = "free" | "paid"

export type DialogTelemetryConsentProps = {
  tier: Tier
  onResult: (accepted: boolean) => void
}

export function DialogTelemetryConsent(props: DialogTelemetryConsentProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const kv = useKV()

  const isFree = () => props.tier === "free"

  const title = () => isFree() ? "Usage Data Collection" : "Enable Usage Telemetry?"

  const message = () =>
    isFree()
      ? "CodeQ collects anonymous usage telemetry to improve the product.\n" +
        "This includes session metrics (token counts, tool usage, latency)\n" +
        "and is required for free-tier accounts. No source code or secrets\n" +
        "are collected. You can review our privacy policy at qbraid.com/privacy."
      : "CodeQ can collect anonymous usage telemetry to help us improve\n" +
        "the product. This includes session metrics like token counts,\n" +
        "tool usage, and latency. No source code or secrets are collected.\n\n" +
        "You can change this anytime in your config:\n" +
        '  qbraid.telemetry.enabled: true | false'

  // Free tier: single button. Paid tier: two-button confirm/decline.
  const buttons = () =>
    isFree() ? ["understand"] as const : ["decline", "enable"] as const

  const [store, setStore] = createStore({
    active: isFree() ? "understand" : "enable",
  })

  const labels: Record<string, string> = {
    understand: "I Understand",
    enable: "Enable",
    decline: "No Thanks",
  }

  let handled = false
  const handleSelect = (key: string) => {
    if (handled) return
    handled = true
    const accepted = key === "understand" || key === "enable"
    kv.set(KV_TELEMETRY_CONSENT_SHOWN, true)
    kv.set(KV_TELEMETRY_ENABLED, accepted)
    Telemetry.setConsent(accepted)
    props.onResult(accepted)
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      handleSelect(store.active)
      return
    }

    if (!isFree() && (evt.name === "left" || evt.name === "right")) {
      setStore("active", store.active === "enable" ? "decline" : "enable")
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {title()}
        </text>
        <Show when={!isFree()}>
          <text fg={theme.textMuted}>esc</text>
        </Show>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{message()}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <For each={buttons() as readonly string[]}>
          {(key) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={key === store.active ? theme.primary : undefined}
              onMouseUp={() => handleSelect(key)}
            >
              <text fg={key === store.active ? theme.selectedListItemText : theme.textMuted}>
                {labels[key]}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

/**
 * Show the consent dialog and return a promise that resolves with the user's choice.
 */
DialogTelemetryConsent.show = (
  dialog: DialogContext,
  tier: Tier,
): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    dialog.replace(
      () => (
        <DialogTelemetryConsent
          tier={tier}
          onResult={(accepted) => resolve(accepted)}
        />
      ),
      // Esc handler: free tier = accept (required), paid tier = decline
      () => resolve(tier === "free"),
    )
  })
}
