# Cloudflare deployment and capacity

BenX targets Workers + D1 + Static Assets, not a long-running Node server. Linux cores and VPN packet processing run on your VPS. [فارسی](guide.fa.md)

## Deployment contract

- Use Node.js 24, `npm ci`, `npm run build`, and `npm run deploy` from repository root.
- Keep `DB`, `ASSETS`, the five-minute cron and the route-first patterns in the supplied Wrangler configuration.
- The release configuration has no owner account ID, database ID, SSH relay or runtime key. Cloudflare provisions D1 and the deploy helper initializes schema and generates keys.
- The runtime uses Web Crypto and the Workers APIs. `nodejs_compat` supports the used compatibility APIs. The SSH library is aliased to a relay-only module; a native SSH stack is not bundled into the Worker.
- Normal deployments preserve keys and owner login. Keep your full D1 backup and original private recovery information before upgrading.
- The deploy button is a source-copy/account-authorization workflow, not a remotely verified deployment of somebody else's panel. Verify fresh installs and existing-install upgrades with your own account.

See [installation](easy-install.md) and Cloudflare's [Deploy-button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

## Optimizations in this source

Static frontend requests use Static Assets. API/subscription/owner paths reach the Worker first where specified. Content-hashed `/assets/*` files have one-year immutable browser caching; entry HTML is revalidated. Private API/subscription responses are `no-store`.

The owner workspace, tools and non-default languages load on demand. The production check rejects published sample fixtures and enforces a 140,000-byte gzip budget for initial JavaScript. Supplied font binaries are omitted from the source kit; system fallbacks remain available.

Schema initialization shares a per-isolate promise, uses an expiring cross-isolate lease and commits each migration with its marker. It preserves completed files on retry. It deliberately keeps initialization below 40 binding calls to leave headroom under D1's Free-plan per-invocation limit.

Authenticated idle agent polls use the already-read heartbeat to skip redundant heartbeat database calls inside the 30-second window. The database update retains its compare condition for competing isolates. Command claiming remains atomic and every poll still checks current node authentication and enabled state.

Scheduled monitoring selects at most four due servers per pass. Commands/results expire from storage after 24 hours under the cron. Existing reconciliation work has its own limits; combined cron and fleet load must still be measured.

## Polling is a real cost

| Agent interval | Idle polls per agent/day | Tradeoff |
| --- | ---: | --- |
| 1 second | 86,400 | Lower command pickup latency, much higher usage |
| 3 seconds, default | 28,800 | Default balance |
| 10 seconds | 8,640 | Fewer requests, slower pickup |

Configure `AGENT_POLL_SECONDS` as an integer from 1 to 10 in Worker variables. This is a runtime variable, not a secret. Polls also consume D1 reads and command-claim queries; these counts are not a billing estimate. Management, subscriptions, logins and cron work add more usage. The saved-server limit is not a promise that the same number of active agents fits a Free account.

Cloudflare currently documents 100,000 Worker requests/day on Free, a 10 ms Free HTTP CPU allowance, and separate D1 row-read/write and per-invocation limits. Waiting for network I/O is different from CPU time. Password hashing, encryption, large profiles, concurrent jobs and fleet reconciliation still need actual CPU/D1 measurement. Check the current [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) against your account before choosing a plan. This source does not guarantee Free-plan operation at arbitrary load.

The initial command waits at most 25 seconds. A timeout does not establish that a claimed privileged action failed. Inspect actual server state and the saved result before retrying. Increasing polling toward 10 seconds can increase timeouts for slow jobs; test your actual tasks.

## Acceptance before production

Verify real account authorization, D1 provisioning, private setup, existing-key upgrade, activation/recovery secrecy, live VPS pairing, the selected protocol/client, expiry and supported quota enforcement. Measure Worker requests/CPU/errors, D1 operations/storage, command age and subscription latency at expected concurrency. Use spare VPSs for restore/replacement and actual test payment accounts for shop acceptance. [Full acceptance checklist](release-acceptance.md).
