# Server connection contracts

The Worker delegates host operations to a management service. The included [BenX agent](../agent/README.md) supplies the full-access server mode. Normal enrollment uses outbound authenticated HTTPS with per-agent identities and an encrypted durable command queue. The optional protected HTTPS origin and private SSH relay paths remain supported. The local HTTP listener stays on loopback. See [launch guide](launch-guide.md).

## Full-access agent

- `GET /benx/v1/capabilities`: confirms `agent: benx-agent`, full access, installed cores, supported protocols, installation availability and platform.
- `GET /benx/v1/jobs`: recent asynchronous core jobs.
- `POST /benx/v1/cores/{core}/{install|start|stop|restart}`: fixed core/service actions. The Worker independently allowlists each path and method and requires a full-access connection.
- A native subset of 3.x status, inbound CRUD, centralized clients, attachments, profile exports, key generation and configuration export is supported. Other panel operations return a clear unsupported-operation error.

The agent does not implement the complete 3X-UI service. Native accounting and Worker subscriptions cover the implemented adapters; global panel-only settings and unimplemented advanced API tools require a compatible panel connection. Claimed command delivery is not replayed automatically after an uncertain result. Core capabilities restrict native inbound choices to implemented adapters.

## Legacy API-compatible gateways

Previously saved gateway connections remain supported. An independently provided gateway must implement the selected panel API contract below.

## Required behavior

Use a publicly reachable HTTPS URL with a valid certificate and an optional base path. Select the API family matching the gateway implementation:

- **3.x**: implement the operations in `shared/operations.json` whose version is `v3`. Prefer `Authorization: Bearer <token>` with appropriate scopes. Session auth requires `/login` and `/csrf-token`.
- **2.x**: implement the reviewed operations whose version is `v2`, along with form-based `/login` returning an HttpOnly session cookie. Inbound/server operations use `/panel/api/...`; settings/Xray operations use `/panel/setting/...` and `/panel/xray/...`.

JSON responses follow the upstream envelope:

```json
{ "success": true, "msg": "", "obj": {} }
```

Errors should return `success: false` and a useful, non-sensitive `msg`. Binary database/migration downloads should return the appropriate binary content type. Database restoration accepts multipart field `db`.

For a useful basic connection, implement status, inbound listing, client online status, settings loading, and Xray template loading. Unsupported operations should return 404; BenX-UI will display the limitation.

## Responsibility on the gateway

The gateway owns persistent Xray configuration and process management, traffic accounting, expiry/quota/IP/device enforcement, TLS/REALITY material, subscription delivery, operating-system integration, and protocol sidecars. It should enforce authorization, payload validation, concurrency, and safe filesystem access independently. A gateway that only supplies status cannot provide full 3X-UI compatibility.

This is a compatibility boundary for existing management services, not a claim that arbitrary bare servers can be managed without any remote management service.
