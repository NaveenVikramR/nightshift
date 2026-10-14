/** JSON-RPC error body for HTTP-level rejections (no request id is known yet). */
export function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}
