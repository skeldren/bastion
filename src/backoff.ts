export function nextReconnectDelayMs(currentDelayMs: number) {
  return Math.min(60_000, currentDelayMs * 2);
}
