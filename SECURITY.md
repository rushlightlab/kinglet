# Security policy

## Supported versions

Security fixes land in the latest release. Pin a release tag (or digest) from
`ghcr.io/rushlightlab/kinglet` and upgrade when a new release ships; the
[changelog](https://kinglet.rushlightlab.com/changelog/) calls out
security-relevant changes.

## Reporting a vulnerability

Please report suspected vulnerabilities in Kinglet, the official SDKs
(`@kinglet/sdk-node`, `rushlightlab/kinglet`), or `@kinglet/mcp` privately
through [GitHub Security Advisories](https://github.com/rushlightlab/kinglet/security/advisories/new).
Do not open a public issue with exploit details.

Include:

- the Kinglet (or package) version or image digest
- the deployment shape: reverse proxy, storage backend, platform
- a minimal reproduction, using dummy data only

We'll review reports as quickly as we can and coordinate disclosure once a fix
is ready.

## Hardening and data handling

- [Security guide](https://kinglet.rushlightlab.com/security/): hardening a
  Kinglet server
- [Privacy & data](https://kinglet.rushlightlab.com/privacy/): what Kinglet
  stores and what leaves your server
