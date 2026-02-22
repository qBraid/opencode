import { Plugin } from "../plugin"
import { Share } from "../share/share"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { Telemetry } from "@/telemetry"
import { QuantumPoller, QuantumState } from "@/quantum"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  Share.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()

  // Initialize qBraid telemetry (CodeQ-specific)
  // This is a no-op if telemetry is disabled by consent or config
  await Telemetry.initIntegration().catch((error) => {
    Log.Default.warn("telemetry initialization failed", { error })
  })

  // Initialize qBraid quantum state polling (credits, jobs, compute)
  QuantumPoller.init()
  QuantumState.refreshAll().catch((error) => {
    Log.Default.warn("quantum state initialization failed", { error })
  })

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}
