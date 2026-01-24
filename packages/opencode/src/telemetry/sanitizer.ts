/**
 * Telemetry Sanitizer
 *
 * Sanitizes telemetry data to remove sensitive information before upload.
 * Critical for user privacy and security.
 */

import crypto from "crypto"

// Patterns that indicate sensitive environment variables
const SENSITIVE_ENV_PATTERNS = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /private/i,
  /api_?key/i,
  /access_?key/i,
]

// File patterns that should never have content included
const SENSITIVE_FILE_PATTERNS = [
  /\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials?\.(json|yaml|yml|toml)$/i,
  /secrets?\.(json|yaml|yml|toml)$/i,
  /service[-_]?account.*\.json$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.ssh\//i,
]

// Common secret value patterns
const SECRET_VALUE_PATTERNS = [
  // API keys (various formats)
  /\b[A-Za-z0-9_-]{32,}\b/g, // Generic long alphanumeric
  /\bsk[-_][A-Za-z0-9]{20,}\b/g, // Stripe-style keys
  /\bghp_[A-Za-z0-9]{36}\b/g, // GitHub personal access tokens
  /\bgho_[A-Za-z0-9]{36}\b/g, // GitHub OAuth tokens
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access key IDs
  /\bey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // JWTs
  /\bqbr_[A-Za-z0-9]{32,}\b/g, // qBraid API keys
]

// Maximum content length before truncation
const MAX_CONTENT_LENGTH = 50000 // 50KB

/**
 * Hash a file path for privacy while maintaining ability to deduplicate
 */
export function hashFilePath(path: string): string {
  return crypto.createHash("sha256").update(path).digest("hex").substring(0, 16)
}

/**
 * Check if a file path matches sensitive patterns
 */
export function isSensitiveFile(path: string, additionalPatterns: string[] = []): boolean {
  const patterns = [...SENSITIVE_FILE_PATTERNS, ...additionalPatterns.map((p) => new RegExp(p))]
  return patterns.some((pattern) => pattern.test(path))
}

/**
 * Check if an environment variable name is sensitive
 */
export function isSensitiveEnvVar(name: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Redact potential secrets from text content
 */
export function redactSecrets(content: string): string {
  let result = content

  // Redact environment variable assignments
  result = result.replace(/^(\s*[A-Z_][A-Z0-9_]*\s*=\s*)(["']?)(.+?)\2$/gm, (match, prefix, quote, value) => {
    const varName = prefix.split("=")[0].trim()
    if (isSensitiveEnvVar(varName)) {
      return `${prefix}${quote}[REDACTED]${quote}`
    }
    return match
  })

  // Redact common secret patterns
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]")
  }

  // Redact Bearer tokens in headers
  result = result.replace(/(Authorization:\s*Bearer\s+)([^\s]+)/gi, "$1[REDACTED]")

  // Redact password-like fields in JSON
  result = result.replace(
    /("(?:password|secret|token|key|credential|auth)[^"]*"\s*:\s*)"([^"]+)"/gi,
    '$1"[REDACTED]"',
  )

  return result
}

/**
 * Truncate content if it exceeds the maximum length
 */
export function truncateContent(content: string, maxLength: number = MAX_CONTENT_LENGTH): string {
  if (content.length <= maxLength) {
    return content
  }

  const truncated = content.substring(0, maxLength)
  const hash = crypto.createHash("sha256").update(content).digest("hex").substring(0, 8)

  return `${truncated}\n\n[TRUNCATED - Original length: ${content.length} bytes, hash: ${hash}]`
}

/**
 * Sanitize message content for telemetry
 */
export function sanitizeContent(content: string, excludePatterns: string[] = []): string {
  // Check if content contains file paths that should be excluded
  const allPatterns = [...SENSITIVE_FILE_PATTERNS, ...excludePatterns.map((p) => new RegExp(p))]

  let sanitized = content

  // Redact secrets
  sanitized = redactSecrets(sanitized)

  // Truncate if too long
  sanitized = truncateContent(sanitized)

  return sanitized
}

/**
 * Sanitize a tool call input/output
 */
export function sanitizeToolData(
  toolName: string,
  data: unknown,
  excludePatterns: string[] = [],
): string | undefined {
  if (data === undefined || data === null) {
    return undefined
  }

  // For file-related tools, check if the path is sensitive
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>
    if (typeof obj.path === "string" || typeof obj.filePath === "string") {
      const path = (obj.path || obj.filePath) as string
      if (isSensitiveFile(path, excludePatterns)) {
        return "[REDACTED - Sensitive file]"
      }
    }
  }

  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2)
  return sanitizeContent(content, excludePatterns)
}

/**
 * Extract file extension from a path
 */
export function getFileExtension(path: string): string {
  const lastDot = path.lastIndexOf(".")
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))

  if (lastDot > lastSlash && lastDot < path.length - 1) {
    return path.substring(lastDot).toLowerCase()
  }

  return ""
}

/**
 * Configuration for the sanitizer
 */
export interface SanitizerConfig {
  excludePatterns: string[]
  maxContentLength: number
}

/**
 * Create a sanitizer with custom configuration
 */
export function createSanitizer(config: Partial<SanitizerConfig> = {}) {
  const finalConfig: SanitizerConfig = {
    excludePatterns: config.excludePatterns ?? [],
    maxContentLength: config.maxContentLength ?? MAX_CONTENT_LENGTH,
  }

  return {
    sanitizeContent: (content: string) => sanitizeContent(content, finalConfig.excludePatterns),
    sanitizeToolData: (toolName: string, data: unknown) =>
      sanitizeToolData(toolName, data, finalConfig.excludePatterns),
    hashFilePath,
    isSensitiveFile: (path: string) => isSensitiveFile(path, finalConfig.excludePatterns),
    getFileExtension,
  }
}
