import { createConnection, type Socket } from "node:net";

const MAX_RESPONSE_BYTES = 256 * 1024;
const AUTH_REQUEST_ID = 1;
const COMMAND_REQUEST_ID = 2;
const SENTINEL_REQUEST_ID = 3;
const COMMAND_RESPONSE_IDLE_MS = 250;

export type AsaRconInput = {
  address: string;
  port: number;
  password: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AsaRconErrorCode =
  | "timeout"
  | "authentication_failed"
  | "invalid_response"
  | "network_error"
  | "aborted";

export class AsaRconError extends Error {
  readonly code: AsaRconErrorCode;

  constructor(code: AsaRconErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.code = code;
    this.name = "AsaRconError";
  }
}

type Packet = { id: number; type: number; body: string };

function encodePacket(id: number, type: number, body: string) {
  const content = Buffer.from(body, "utf8");
  const size = 4 + 4 + content.length + 2;
  const packet = Buffer.allocUnsafe(size + 4);
  packet.writeInt32LE(size, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  content.copy(packet, 12);
  packet.writeUInt16LE(0, 12 + content.length);
  return packet;
}

function parsePackets(buffer: Buffer) {
  const packets: Packet[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || size > MAX_RESPONSE_BYTES) {
      throw new AsaRconError("invalid_response");
    }
    if (buffer.length - offset < size + 4) break;
    const end = offset + size + 4;
    if (buffer[end - 2] !== 0 || buffer[end - 1] !== 0) {
      throw new AsaRconError("invalid_response");
    }
    packets.push({
      id: buffer.readInt32LE(offset + 4),
      type: buffer.readInt32LE(offset + 8),
      body: buffer.toString("utf8", offset + 12, end - 2),
    });
    offset = end;
  }
  return { packets, rest: buffer.subarray(offset) };
}

function validateInput(input: AsaRconInput) {
  if (
    !input.address.trim() ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535 ||
    !input.password ||
    input.password.length > 1_024
  ) {
    throw new AsaRconError("network_error");
  }
}

async function executeRcon(input: AsaRconInput, command?: string) {
  validateInput(input);
  if (input.signal?.aborted) throw new AsaRconError("aborted");
  const timeoutMs = input.timeoutMs ?? 3_000;

  return new Promise<string>((resolve, reject) => {
    const socket: Socket = createConnection({
      host: input.address,
      port: input.port,
    });
    let buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let authenticated = false;
    let settled = false;
    const output: string[] = [];
    let responseIdleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: unknown, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (responseIdleTimer) clearTimeout(responseIdleTimer);
      input.signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      if (error instanceof AsaRconError) reject(error);
      else if (error)
        reject(new AsaRconError("network_error", { cause: error }));
      else resolve(value);
    };
    const finishAfterResponseIdle = () => {
      if (responseIdleTimer) clearTimeout(responseIdleTimer);
      responseIdleTimer = setTimeout(
        () => finish(undefined, output.join("")),
        Math.min(COMMAND_RESPONSE_IDLE_MS, timeoutMs),
      );
    };
    const onAbort = () => finish(new AsaRconError("aborted"));
    const timer = setTimeout(
      () => finish(new AsaRconError("timeout")),
      timeoutMs,
    );

    input.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(encodePacket(AUTH_REQUEST_ID, 3, input.password));
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES)
          throw new AsaRconError("invalid_response");
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parsePackets(buffer);
        buffer = parsed.rest;
        for (const packet of parsed.packets) {
          if (!authenticated) {
            if (packet.type !== 2) continue;
            if (packet.id === -1)
              throw new AsaRconError("authentication_failed");
            if (packet.id !== AUTH_REQUEST_ID)
              throw new AsaRconError("invalid_response");
            authenticated = true;
            if (command === undefined) {
              finish(undefined, "");
              return;
            }
            socket.write(encodePacket(COMMAND_REQUEST_ID, 2, command));
            socket.write(encodePacket(SENTINEL_REQUEST_ID, 2, ""));
            continue;
          }
          if (packet.type !== 0) continue;
          if (packet.id === COMMAND_REQUEST_ID) {
            output.push(packet.body);
            finishAfterResponseIdle();
          }
          if (packet.id === SENTINEL_REQUEST_ID) {
            finish(undefined, output.join(""));
            return;
          }
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new AsaRconError("invalid_response"));
    });
  });
}

export async function checkAsaRcon(input: AsaRconInput) {
  await executeRcon(input);
}

export function countAsaListPlayers(response: string) {
  const normalized = response.replace(/\r/g, "").trim();
  if (!normalized || /no players (?:are )?connected/i.test(normalized))
    return 0;
  const count = normalized
    .split("\n")
    .filter((line) => /^\s*\d+\.\s+/.test(line)).length;
  if (count === 0) throw new AsaRconError("invalid_response");
  return count;
}

export async function queryAsaPlayerCount(input: AsaRconInput) {
  return countAsaListPlayers(await executeRcon(input, "ListPlayers"));
}

export async function broadcastAsaMessage(
  input: AsaRconInput,
  message: string,
) {
  const value = message.trim();
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AsaRconError("invalid_response");
  }
  await executeRcon(input, `Broadcast ${value}`);
}

export async function saveAsaWorld(input: AsaRconInput) {
  await executeRcon(input, "SaveWorld");
}

export const asaRconPacketFixture = { encodePacket, parsePackets };
