import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nextReconnectDelayMs } from "./backoff.js";
import { createJobResult } from "./job-result.js";
import { isIP } from "node:net";
import {
  broadcastAsaMessage,
  checkAsaRcon,
  queryAsaPlayerCount,
  saveAsaWorld,
} from "./rcon.js";

const statePath =
  process.env.SKELDREN_BASTION_STATE_PATH ??
  "/var/lib/skeldren-bastion/device.json";
const apiUrl = normalizeApiUrl(process.env.SKELDREN_URL ?? "");

type DeviceState = {
  id: string;
  credential: string;
  privateKeyPem: string;
  publicKeyPem: string;
  pollIntervalMs: number;
};

type Job = {
  id: string;
  type: "connection_test" | "player_refresh" | "broadcast" | "save_world";
  payload: unknown;
  targetHost: string;
  port: number;
  passwordCiphertext: string;
};

async function main() {
  const state = (await loadState()) ?? (await pairDevice());
  process.stdout.write(`Skeldren Bastion ${state.id} ist verbunden.\n`);
  let reconnectDelayMs = 5_000;
  while (true) {
    try {
      const job = await nextJob(state);
      if (job) await executeJob(state, job);
      reconnectDelayMs = 5_000;
      await wait(state.pollIntervalMs);
    } catch (error) {
      const name = error instanceof Error ? error.name : "BastionError";
      process.stderr.write(
        `Skeldren Bastion Verbindung unterbrochen (${name}).\n`,
      );
      await wait(reconnectDelayMs);
      reconnectDelayMs = nextReconnectDelayMs(reconnectDelayMs);
    }
  }
}

async function pairDevice() {
  const code = process.env.SKELDREN_PAIRING_CODE?.trim();
  if (!code)
    throw new Error("SKELDREN_PAIRING_CODE is required for first setup");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const response = await request<{
    id: string;
    credential: string;
    pollIntervalMs: number;
  }>("/api/bastion/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      publicKeyPem: publicKey,
      version: process.env.SKELDREN_BASTION_VERSION ?? "dev",
    }),
  });
  const state: DeviceState = {
    ...response,
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
  };
  await saveState(state);
  return state;
}

async function nextJob(state: DeviceState) {
  const result = await request<{ job: Job | null }>("/api/bastion/jobs", {
    headers: deviceHeaders(state),
  });
  return result.job;
}

async function executeJob(state: DeviceState, job: Job) {
  let players: number | undefined;
  let success = false;
  let errorCode = "connection_unavailable";
  try {
    const input = {
      address: validateTarget(job.targetHost),
      port: validatePort(job.port),
      password: decryptPassword(state.privateKeyPem, job.passwordCiphertext),
      timeoutMs: job.type === "connection_test" ? 3_000 : 10_000,
    };
    if (job.type === "connection_test") await checkAsaRcon(input);
    else if (job.type === "player_refresh")
      players = await queryAsaPlayerCount(input);
    else if (job.type === "broadcast")
      await broadcastAsaMessage(input, actionMessage(job.payload));
    else if (job.type === "save_world") await saveAsaWorld(input);
    else throw new Error("unsupported_action");
    success = true;
  } catch (error) {
    errorCode = safeErrorCode(error);
  }
  await request(`/api/bastion/jobs/${encodeURIComponent(job.id)}`, {
    method: "POST",
    headers: { ...deviceHeaders(state), "content-type": "application/json" },
    body: JSON.stringify(createJobResult(success, players, errorCode)),
  });
}

function deviceHeaders(state: DeviceState) {
  return {
    authorization: `Bearer ${state.credential}`,
    "x-skeldren-bastion-id": state.id,
    "x-skeldren-bastion-version":
      process.env.SKELDREN_BASTION_VERSION ?? "dev",
  };
}

async function request<T = { accepted: boolean }>(
  path: string,
  init?: RequestInit,
) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string };
  } | null;
  if (!response.ok || payload?.data === undefined)
    throw new Error(payload?.error?.code ?? `http_${response.status}`);
  return payload.data;
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as DeviceState;
    if (!parsed.id || !parsed.credential || !parsed.privateKeyPem) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveState(state: DeviceState) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.new`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, statePath);
}

function decryptPassword(privateKeyPem: string, ciphertext: string) {
  const encrypted = Buffer.from(ciphertext, "base64");
  if (!encrypted.length || encrypted.length > 1_024)
    throw new Error("invalid_ciphertext");
  return privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    encrypted,
  ).toString("utf8");
}

function validateTarget(value: string) {
  if (!value || value.length > 253 || (!isIP(value) && /[\s/:@?#]/.test(value)))
    throw new Error("invalid_target");
  return value;
}

function validatePort(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error("invalid_port");
  return value;
}

function actionMessage(payload: unknown) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object")
    throw new Error("invalid_action_payload");
  const message = (payload as Record<string, unknown>).message;
  if (typeof message !== "string") throw new Error("invalid_action_payload");
  return message;
}

function safeErrorCode(error: unknown) {
  const value =
    error instanceof Error ? error.message : "connection_unavailable";
  return /^[a-z0-9_]{1,60}$/.test(value) ? value : "connection_unavailable";
}

function normalizeApiUrl(value: string) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error("SKELDREN_URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(500, ms)));
}

void main().catch((error) => {
  process.stderr.write(
    `Skeldren Bastion konnte nicht gestartet werden (${error instanceof Error ? error.name : "BastionError"}).\n`,
  );
  process.exitCode = 1;
});
