# Security Policy

## Reporting a vulnerability

Please use GitHub's private security advisory flow for this repository. Do not
open a public issue containing credentials, pairing codes, private network
targets, raw RCON responses or exploit details.

## Supported releases

Only the latest signed release digest is supported. Skeldren-generated Compose
files pin that digest explicitly; mutable image tags are not supported.

## Runtime boundary

The official container runs as UID 10001 with a read-only root filesystem,
all Linux capabilities removed, no Docker socket, no host network and only its
device-state volume writable.
