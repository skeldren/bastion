import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  AsaRconError,
  asaRconPacketFixture,
  checkAsaRcon,
  countAsaListPlayers,
  broadcastAsaMessage,
  queryAsaPlayerCount,
  saveAsaWorld,
} from "./rcon.js";

test("counts ASA players without returning identities", () => {
  assert.equal(
    countAsaListPlayers(
      "0. Survivor One, 76561190000000001\n1. Survivor Two, 76561190000000002",
    ),
    2,
  );
  assert.equal(countAsaListPlayers("No Players Connected"), 0);
});

test("times out after one connection and never retries", async () => {
  let connections = 0;
  let acceptConnection: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    acceptConnection = resolve;
  });
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    connections += 1;
    acceptConnection?.();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const request = checkAsaRcon({
      address: "127.0.0.1",
      port: address.port,
      password: "secret",
      timeoutMs: 500,
    });
    await connected;
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof AsaRconError && error.code === "timeout",
    );
    assert.equal(connections, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rejects unsafe broadcasts before opening a socket", async () => {
  await assert.rejects(
    broadcastAsaMessage(
      { address: "127.0.0.1", port: 1, password: "secret" },
      "hello\nSaveWorld",
    ),
    (error: unknown) =>
      error instanceof AsaRconError && error.code === "invalid_response",
  );
  await assert.rejects(
    broadcastAsaMessage(
      { address: "127.0.0.1", port: 1, password: "secret" },
      "x".repeat(201),
    ),
    (error: unknown) =>
      error instanceof AsaRconError && error.code === "invalid_response",
  );
});

test("RCON packet parser fails closed for malformed frames", () => {
  for (let length = 0; length < 128; length += 1) {
    const fixture = Buffer.alloc(length, length);
    try {
      const parsed = asaRconPacketFixture.parsePackets(fixture);
      assert(parsed.rest.length <= fixture.length);
    } catch (error) {
      assert(error instanceof AsaRconError);
      assert.equal(error.code, "invalid_response");
    }
  }
});

test("authenticates once and joins a multi-packet ListPlayers response", async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = asaRconPacketFixture.parsePackets(buffer);
      buffer = parsed.rest;
      for (const packet of parsed.packets) {
        if (packet.type === 3) {
          socket.write(asaRconPacketFixture.encodePacket(packet.id, 2, ""));
        } else if (packet.id === 2) {
          socket.write(
            asaRconPacketFixture.encodePacket(
              packet.id,
              0,
              "0. Survivor One, 76561190000000001\n",
            ),
          );
          socket.write(
            asaRconPacketFixture.encodePacket(
              packet.id,
              0,
              "1. Survivor Two, 76561190000000002",
            ),
          );
        } else if (packet.id === 3) {
          socket.write(asaRconPacketFixture.encodePacket(packet.id, 0, ""));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    assert.equal(
      await queryAsaPlayerCount({
        address: "127.0.0.1",
        port: address.port,
        password: "secret",
        timeoutMs: 500,
      }),
      2,
    );
    assert.equal(connections, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rejects authentication failure and does not retry", async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.once("data", () => {
      socket.write(asaRconPacketFixture.encodePacket(-1, 2, ""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await assert.rejects(
      checkAsaRcon({
        address: "127.0.0.1",
        port: address.port,
        password: "wrong",
        timeoutMs: 500,
      }),
      (error: unknown) =>
        error instanceof AsaRconError && error.code === "authentication_failed",
    );
    assert.equal(connections, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("aborts one in-flight connection and closes its socket", async () => {
  let connections = 0;
  let closed = false;
  let acceptConnection: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    acceptConnection = resolve;
  });
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    acceptConnection?.();
    socket.once("close", () => {
      closed = true;
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const controller = new AbortController();
  try {
    const request = checkAsaRcon({
      address: "127.0.0.1",
      port: address.port,
      password: "secret",
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await connected;
    controller.abort();
    await assert.rejects(
      request,
      (error: unknown) =>
        error instanceof AsaRconError && error.code === "aborted",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(connections, 1);
    assert.equal(closed, true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("sends only the typed SaveWorld command", async () => {
  let command = "";
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = asaRconPacketFixture.parsePackets(buffer);
      buffer = parsed.rest;
      for (const packet of parsed.packets) {
        if (packet.type === 3) {
          socket.write(asaRconPacketFixture.encodePacket(packet.id, 2, ""));
        } else if (packet.id === 2) {
          command = packet.body;
          socket.write(asaRconPacketFixture.encodePacket(packet.id, 0, ""));
        } else if (packet.id === 3) {
          socket.write(asaRconPacketFixture.encodePacket(packet.id, 0, ""));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await saveAsaWorld({
      address: "127.0.0.1",
      port: address.port,
      password: "secret",
      timeoutMs: 500,
    });
    assert.equal(command, "SaveWorld");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
