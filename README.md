# Skeldren Bastion

Skeldren Bastion is the narrow, outbound-only connector between Skeldren and
private ARK: Survival Ascended RCON endpoints. It is not a VPN, proxy, shell or
general console.

The connector accepts only four typed actions: connection checks,
`ListPlayers`, `Broadcast` and `SaveWorld`. Player names, identifiers and raw
RCON responses are never returned to Skeldren or persisted by the Bastion.

## Recommended installation

Create and pair a Bastion in the Skeldren Community Owner dashboard, then copy
or download the generated `compose.yaml`. The generated file contains a
single-use pairing code and an immutable signed image digest.

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose logs --tail=50
```

Do not replace the digest with `latest` or another mutable tag.

## Equivalent Docker command

Docker Compose is recommended. The equivalent first-run command is:

```bash
docker volume create skeldren-bastion-data
docker run -d \
  --name skeldren-bastion \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  -e SKELDREN_URL=https://dev.skeldren.com \
  -e SKELDREN_PAIRING_CODE=REPLACE-WITH-ONE-TIME-CODE \
  -v skeldren-bastion-data:/var/lib/skeldren-bastion \
  ghcr.io/skeldren/bastion@sha256:REPLACE_WITH_SIGNED_IMAGE_DIGEST
```

## Development

Requires Node.js 24 and Corepack.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
docker build -t skeldren-bastion:local .
```

Releases are built only from `v*` tags. The GitHub workflow publishes an SBOM
and provenance, scans the immutable image, and signs its digest with Cosign.

## Promotion branches

Changes start on `dev`, are promoted to `uat`, and reach `main` only for a
Production release. The matching immutable release tags are:

- `vX.Y.Z-dev.N` from `dev`
- `vX.Y.Z-rc.N` from `uat`
- `vX.Y.Z` from `main`

The release workflow verifies that each tag is reachable from its required
branch. Environment deployments approve an exact digest; they never deploy a
branch name or a mutable image tag.

## Security

See [SECURITY.md](SECURITY.md). Never include pairing codes, device state,
credentials or RCON passwords in issues or logs.

## License

Apache License 2.0.
