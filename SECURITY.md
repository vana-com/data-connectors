# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Data Connectors, please report it
privately. **Do not open a public GitHub issue for security reports.**

Use GitHub's private vulnerability reporting for this repository
("Security" tab → "Report a vulnerability"), or contact a maintainer listed in
[`MAINTAINERS.md`](MAINTAINERS.md) directly.

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof of concept.
- The affected connector(s), file(s), or version(s).

We will acknowledge your report as promptly as we can, keep you informed of
progress toward a fix, and credit you in the disclosure unless you prefer to
remain anonymous.

## Scope

This repository contains browser-automation connectors that run **on the user's
device** and extract that user's own data. Connectors do not transmit
credentials or tokens off-device. Reports of particular interest include:

- A connector that exfiltrates credentials, tokens, or personal data to any
  third-party endpoint.
- Committed secrets or real personal data (in the tree or in history).
- A supply-chain or integrity weakness in the connector distribution path
  (registry checksums, signed release index).

## Supported versions

Connectors are versioned and distributed individually. Security fixes are
applied to the current version of each affected connector; downstream consumers
pin and update connector versions independently.
