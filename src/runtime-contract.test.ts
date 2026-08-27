import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("keeps the Bastion runtime and container narrowly bounded", async () => {
  const [runtime, dockerfile, compose, release] = await Promise.all([
    read("src/index.ts"),
    read("Dockerfile"),
    read("compose.example.yaml"),
    read(".github/workflows/release.yml"),
  ]);

  assert.match(
    runtime,
    /connection_test.*player_refresh.*broadcast.*save_world/s,
  );
  assert.match(runtime, /mode: 0o600/);
  assert.doesNotMatch(runtime, /exec\(|spawn\(|child_process|docker\.sock/i);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /apk upgrade --no-cache libcrypto3 libssl3/);
  assert.match(dockerfile, /SKELDREN_BASTION_VERSION=/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.doesNotMatch(
    compose,
    /network_mode:\s*host|docker\.sock|privileged:\s*true|:latest/,
  );
  assert.match(release, /ghcr\.io\/\$\{\{ github\.repository \}\}/);
  assert.match(release, /sbom: true/);
  assert.match(release, /provenance: mode=max/);
  assert.match(release, /cosign sign --yes/);
  assert.match(release, /visibility=public/);
  assert.doesNotMatch(release, /:latest/);
});
