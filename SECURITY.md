# Security

Please report vulnerabilities privately using GitHub's private vulnerability
reporting on this repository. Do not include credentials in public issues.

Discord requests are signature-verified. Monitor messages use bot authorization;
interaction replies use Discord's short-lived interaction token. There is no
public administrative endpoint and no incoming alert webhook.

Runtime secrets stay encrypted in Cloudflare. CI requires only a Cloudflare
deployment token and account ID. Scope the token to the intended account and
restrict repository/environment write access: someone who can deploy Worker
code can use that Worker's secrets. D1 access is needed to bind the existing DB;
CI does not reset, export, or migrate production state automatically.

Public `/monitor/status` intentionally exposes the configured public Riot IDs,
check timestamps and readiness flags, but never credentials or Discord IDs.
Disable `MONITOR_ENABLED` before maintenance. It stops monitor network/D1 work
and deployment metadata reconciliation, not interactive slash commands.

Riot development keys expire. Refresh them securely with Wrangler or obtain an
approved longer-lived key; the bot never scrapes private clients or renews keys
by bypassing Riot authentication. Never paste credentials into chat or issues.
