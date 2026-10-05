# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this repository rather than opening a public issue.
Include steps to reproduce and the affected version or commit. You can expect an acknowledgement within a few days.

## Scope and design notes

- The hosted service only reads **public** GitHub repositories and refuses private ones even if its token could read them.
- Repository contents are treated as untrusted input everywhere, including in anything passed to a language model.
- Secrets detected in a scanned repository are never echoed back; findings show the file, line and a short prefix only.

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the full list.
