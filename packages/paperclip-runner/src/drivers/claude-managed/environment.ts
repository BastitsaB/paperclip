/**
 * Builds the complete environment visible to runnerd for a Claude Managed
 * Agent execution. Paperclip credentials and ambient application state are
 * deliberately excluded; runnerd receives only runtime basics and the
 * Anthropic credential needed by the remote provider.
 */
export function createSanitizedClaudeManagedEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const source = environment ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "RUST_BACKTRACE", "ANTHROPIC_API_KEY",
    "PAPERCLIP_NATIVE_MCP_NAME", "PAPERCLIP_NATIVE_MCP_URL", "PAPERCLIP_NATIVE_MCP_TOKEN",
  ]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}
