/**
 * Jupyter Integration Client
 *
 * Connects to a user's running qBraid compute server via the JupyterHub API.
 * Provides file operations (Contents API) and code execution (kernel WebSocket).
 *
 * Auth flow:
 *   1. Get session token from qBraid API: GET /compute/servers/session-token
 *   2. Use token to authenticate to JupyterHub: Authorization: token {token}
 *   3. Hit Jupyter REST APIs on the user's pod at:
 *      https://{clusterId}.qbraid.com/user/{username}/api/...
 */

import { Log } from "../util/log"
import * as crypto from "crypto"

const log = Log.create({ service: "quantum:jupyter" })

const EXEC_TIMEOUT = 60_000
const WS_CONNECT_TIMEOUT = 10_000

// --- Types ---

export interface JupyterSession {
  token: string
  username: string
  clusterId: string
  baseUrl: string
}

export interface FileEntry {
  name: string
  path: string
  type: "file" | "directory" | "notebook"
  size: number
  lastModified: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  status: "ok" | "error"
  error?: { name: string; value: string; traceback: string[] }
}

// --- Session resolution ---

/**
 * Resolve a Jupyter session from a qBraid API response.
 * Requires the compute server to be running.
 */
export function sessionFromApi(data: {
  clusterId: string
  token: { token: string; user: string }
}): JupyterSession {
  return {
    token: data.token.token,
    username: data.token.user,
    clusterId: data.clusterId,
    baseUrl: `https://${data.clusterId}.qbraid.com/user/${data.token.user}`,
  }
}

// --- HTTP helper ---

async function jupyterFetch(
  session: JupyterSession,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${session.baseUrl}${path}`
  log.debug("jupyter request", { url, method: options?.method ?? "GET" })
  return fetch(url, {
    ...options,
    headers: {
      "Authorization": `token ${session.token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  })
}

// --- Contents API ---

/**
 * List files in a directory on the remote server.
 */
export async function listFiles(
  session: JupyterSession,
  dirPath = "",
  signal?: AbortSignal,
): Promise<FileEntry[]> {
  const encoded = dirPath ? `/${encodeURI(dirPath)}` : ""
  const res = await jupyterFetch(session, `/api/contents${encoded}`, { signal })
  if (!res.ok) throw new Error(`Failed to list files: ${res.status}`)
  const data = await res.json()
  const items = data.content ?? []
  return items.map((item: Record<string, unknown>) => ({
    name: String(item.name ?? ""),
    path: String(item.path ?? ""),
    type: item.type === "directory" ? "directory" : item.type === "notebook" ? "notebook" : "file",
    size: Number(item.size ?? 0),
    lastModified: String(item.last_modified ?? ""),
  }))
}

/**
 * Read a file's content from the remote server.
 */
export async function readFile(
  session: JupyterSession,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await jupyterFetch(session, `/api/contents/${encodeURI(filePath)}`, { signal })
  if (!res.ok) throw new Error(`Failed to read file: ${res.status}`)
  const data = await res.json()
  if (data.type === "notebook") {
    return JSON.stringify(data.content, null, 2)
  }
  return String(data.content ?? "")
}

/**
 * Write a file to the remote server.
 */
export async function writeFile(
  session: JupyterSession,
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const isNotebook = filePath.endsWith(".ipynb")
  const body = isNotebook
    ? { type: "notebook", format: "json", content: JSON.parse(content) }
    : { type: "file", format: "text", content }

  const res = await jupyterFetch(session, `/api/contents/${encodeURI(filePath)}`, {
    method: "PUT",
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200)
    throw new Error(`Failed to write file (${res.status}): ${text}`)
  }
}

// --- Kernel execution ---

/**
 * Execute Python code on the remote server via WebSocket kernel protocol.
 *
 * 1. Starts a new kernel (or reuses an existing one)
 * 2. Connects via WebSocket to the kernel channels
 * 3. Sends an execute_request
 * 4. Collects stdout/stderr and waits for execute_reply
 * 5. Shuts down the kernel
 */
export async function executeCode(
  session: JupyterSession,
  code: string,
  options?: { timeout?: number; kernelName?: string; signal?: AbortSignal },
): Promise<ExecResult> {
  const timeout = options?.timeout ?? EXEC_TIMEOUT
  const kernelName = options?.kernelName ?? "python3"

  // Start a kernel
  const startRes = await jupyterFetch(session, "/api/kernels", {
    method: "POST",
    body: JSON.stringify({ name: kernelName }),
    signal: options?.signal,
  })
  if (!startRes.ok) throw new Error(`Failed to start kernel: ${startRes.status}`)
  const kernel = (await startRes.json()) as { id: string }
  const kernelId = kernel.id
  log.debug("kernel started", { kernelId })

  try {
    const result = await executeOnKernel(session, kernelId, code, timeout)
    return result
  } finally {
    // Always clean up the kernel
    jupyterFetch(session, `/api/kernels/${kernelId}`, { method: "DELETE" }).catch(() => {})
  }
}

async function executeOnKernel(
  session: JupyterSession,
  kernelId: string,
  code: string,
  timeout: number,
): Promise<ExecResult> {
  const wsUrl = `wss://${session.clusterId}.qbraid.com/user/${session.username}/api/kernels/${kernelId}/channels?token=${session.token}`

  return new Promise<ExecResult>((resolve, reject) => {
    const msgId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const stdout: string[] = []
    const stderr: string[] = []
    let resolved = false

    const timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      ws.close()
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join("") + "\n[Execution timed out]",
        status: "error",
      })
    }, timeout)

    const ws = new WebSocket(wsUrl)

    ws.addEventListener("open", () => {
      log.debug("kernel ws connected", { kernelId })
      ws.send(JSON.stringify({
        header: {
          msg_id: msgId,
          msg_type: "execute_request",
          username: "",
          session: sessionId,
          date: new Date().toISOString(),
          version: "5.3",
        },
        parent_header: {},
        metadata: {},
        content: {
          code,
          silent: false,
          store_history: false,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: true,
        },
        buffers: [],
        channel: "shell",
      }))
    })

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data))
        const msgType = msg.msg_type ?? msg.header?.msg_type ?? ""
        const parentId = msg.parent_header?.msg_id

        // Only process messages for our request
        if (parentId && parentId !== msgId) return

        if (msgType === "stream") {
          const name = msg.content?.name
          const text = msg.content?.text ?? ""
          if (name === "stdout") stdout.push(text)
          if (name === "stderr") stderr.push(text)
        }

        if (msgType === "error") {
          const err = msg.content ?? {}
          stderr.push(err.traceback?.join("\n") ?? `${err.ename}: ${err.evalue}`)
        }

        if (msgType === "execute_reply") {
          if (resolved) return
          resolved = true
          clearTimeout(timer)
          ws.close()
          const status = msg.content?.status === "ok" ? "ok" : "error"
          resolve({
            stdout: stdout.join(""),
            stderr: stderr.join(""),
            status,
            error: status === "error" ? {
              name: msg.content?.ename ?? "Error",
              value: msg.content?.evalue ?? "",
              traceback: msg.content?.traceback ?? [],
            } : undefined,
          })
        }
      } catch {
        // ignore parse errors from binary frames
      }
    })

    ws.addEventListener("error", (event) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      reject(new Error(`WebSocket error connecting to kernel`))
    })

    ws.addEventListener("close", () => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join("") + "\n[Connection closed]",
        status: "error",
      })
    })

    // Connect timeout
    setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }, WS_CONNECT_TIMEOUT)
  })
}

/**
 * List available kernel specs on the remote server.
 */
export async function listKernelSpecs(
  session: JupyterSession,
  signal?: AbortSignal,
): Promise<{ name: string; displayName: string; language: string }[]> {
  const res = await jupyterFetch(session, "/api/kernelspecs", { signal })
  if (!res.ok) return []
  const data = await res.json()
  return Object.entries(data.kernelspecs ?? {}).map(([name, spec]: [string, any]) => ({
    name,
    displayName: spec.spec?.display_name ?? name,
    language: spec.spec?.language ?? "unknown",
  }))
}
