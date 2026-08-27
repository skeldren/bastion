export function createJobResult(
  success: boolean,
  players: number | undefined,
  errorCode: string,
) {
  if (!success) return { success: false as const, errorCode };
  return players === undefined
    ? { success: true as const }
    : { success: true as const, players };
}
