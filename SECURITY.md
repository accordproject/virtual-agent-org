# Security Policy

## Supported Versions

Only the deployed version, the `main` branch, receives security fixes.

## Reporting a Vulnerability

Please email security@accordproject.org rather than opening a public issue, and mention:

- this repo
- what an attacker could do, and how
- reproduction steps

Reports we especially want:

- **Prompt injection** that makes an agent act against its spec: text in a pull
  request, issue, transcript or web page that gets an agent to take an action, reveal
  its instructions or notes, or skip the decision queue.
- **Gateway authentication:** any way to reach the gateway's tools or approval actions
  without a valid Telegram secret, Discord signature or Managed Agents webhook signature.
- **Owner rights:** any way for someone other than the owner to approve, instruct,
  pause or revoke.
- **Credential exposure:** tokens, keys or people's platform ids in the repo, logs,
  agent output or public messages.

We will acknowledge your report and agree a timeline for a fix and disclosure.
