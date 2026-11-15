# Validation — 2026-11-15

BenX-UI 0.9 source preview, maintained as **Ben the Builder**. This report describes reproducible local evidence; it does not certify bug-free software or a live production deployment. [فارسی](guide.fa.md)

## Automated evidence

| Check | Result |
| --- | --- |
| TypeScript and ESLint | Passed |
| Application/Worker unit and integration tests | 45 files, 424 tests passed |
| Python/Linux agent tests | 116 passed |
| Production frontend build | Passed; about 78.5 KB initial gzip JavaScript, below the 140,000-byte budget |
| Production sample fixture exclusion | Passed |
| Cloudflare bundle dry run | Passed via local runtime checks; no account deployment |
| Fresh workerd + D1 installation | Passed: automatic schema, first-install claim, one-use activation and generated login |
| Account security in workerd | Passed: original internal seed rejected, credential change, older-session revocation and original-key recovery export |
| Authenticated API smoke checks | 12 read routes returned valid JSON with no-store; the same routes rejected anonymous access |
| Enrollment in workerd | Passed: cross-origin creation rejected, private installer, authenticated ping/pair/poll and browser-cookie-only polling rejected |
| Credential redaction | Pairing secret absent from server listing; malformed public subscription rejected |
| Optional SSH runtime | Passed with a local fixture: pinned identity, handshake, sequential commands, large UTF-8 input, missing-exit-status rejection, agent forwarding and key generation |
| Optional relay | Build and JavaScript syntax check passed |
| npm advisory scan | 0 known vulnerabilities after updates, including development dependencies |

The security scan initially reported 15 dependency findings, including high/critical development-tool issues. Vite, Vitest, Wrangler, Cloudflare types and TypeScript ESLint were updated; TypeScript ESLint's nested minimatch is pinned to the patched 11.0.1. The lockfile uses the official npm registry and the build/runtime tools are reproducible. Advisory coverage changes over time; rerun the scan.

The polling regression test verifies that a recent authenticated heartbeat skips its redundant D1 update request, while an older heartbeat refreshes before the offline deadline. Atomic command claiming and SQL heartbeat fencing remain in place. Static hash-named assets use immutable browser caching; APIs/subscriptions retain no-store.

A clean source install exposed an optional SSH fixture bundling failure when npm compiled ssh2's native addon. The local workerd fixture now explicitly disables that optional addon and verifies the JavaScript crypto path. The production Worker already uses a relay-only alias; native addons are not part of its bundle. Personal sample naming was also replaced with neutral sample text before publication.

The source package uses an explicit allowlist, substitutes a credential-free Wrangler configuration, checks for private runtime values/account IDs and excludes operational files, logs, caches and supplied font binaries. Review the exact publication folder; do not upload the original operational workspace wholesale.

## What has not been established

No real Cloudflare account install/upgrade or resource writes are established by these tests. A bundle dry run is not a deployed Worker. The complete deploy-button consent/provisioning path needs live account acceptance.

Tests simulate external providers, Linux commands and package installation. They do not establish live VPN protocol/client connectivity, kernel/firewall/NAT behavior, real core quota enforcement, tunnel quality, provider DNS writes, Telegram payments/refunds, AI provider availability, or restore/replacement safety on actual VPSs. No customer or operational server was modified by this validation.

The local runtime does not establish Cloudflare Free-plan CPU or fleet capacity. Polling adds about 28,800 requests per agent/day at the default three-second interval, before other work. Measure CPU, requests, D1 operations, storage and queue latency in your account.

## Reproduce

Use a clean checkout with Node.js 24 and Python 3.11+:

```sh
npm ci
npm audit --registry=https://registry.npmjs.org
npm run release:check
npm run release:package
```

Then complete [release acceptance](release-acceptance.md) on an isolated Worker and spare VPSs. Feature gaps remain listed in [README](../README.md) and [feature coverage](feature-matrix.md).
