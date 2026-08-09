# Security policy

## Supported version

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. Use GitHub's private vulnerability reporting for this repository. Include reproduction steps, affected routes, expected impact, and any suggested mitigation.

Do not include real credentials, private documents, or private conversation exports in a report. You should receive an initial response within seven days.

## Deployment notes

- Keep Cloudflare rate-limit bindings enabled for anonymous publishing.
- Treat `.dev.vars`, API tokens, and account credentials as secrets.
- Restrict R2 access to the Worker rather than exposing the bucket publicly.
- Review `wrangler.jsonc` resource IDs and domain routes before deploying a fork.
- Notelet exports readable reasoning summaries only; it must not publish hidden chain-of-thought or system instructions.
