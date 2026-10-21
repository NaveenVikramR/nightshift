/**
 * Shared AWS SDK client settings. The SDK has no request timeout by default: in
 * the live run a stale keep-alive connection made ApplyGuardrail hang until our
 * 35 s turn guard fired. Short connect/request timeouts plus SDK retries turn
 * that into a quick retry on a fresh connection.
 */
export function awsClientConfig(region: string) {
  return {
    region,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 8_000 },
  };
}
