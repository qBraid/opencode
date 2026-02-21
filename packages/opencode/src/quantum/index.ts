/**
 * Quantum Module
 *
 * Native quantum computing integration for CodeQ.
 * Provides in-process tools for device management, job submission,
 * cost estimation, and result retrieval via the qBraid API.
 *
 * This replaces the pod_mcp MCP server for core quantum workflows,
 * giving CodeQ tight integration with auth, permissions, and telemetry.
 */

export { QUANTUM_TOOLS } from "./tools"
export * as QuantumClient from "./client"
