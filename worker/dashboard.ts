import { configurationView } from '../shared/managed';
import { controlRoute, managedRow, savedDocument } from './control';
import { callRemoteJson, type StoredServer } from './remote';
import { HttpError } from './security';

// One authenticated request and one profile decryption instead of five requests.
export async function dashboard(request: Request, env: Env, server: StoredServer, ctx: ExecutionContext) {
  if (request.method !== 'GET' || server.kind !== 'server') throw new HttpError(400, 'This snapshot requires a full-access server.');
  const row = await managedRow(env, server.id);
  const document = row ? await savedDocument(env, row) : null;
  const controlRequest = new Request('https://benx.internal/control?summary=1');
  const includeCapabilities = new URL(request.url).searchParams.get('capabilities') === '1';
  const savedOnly = new URL(request.url).searchParams.get('saved') === '1';
  const readLiveInbounds = !document && !savedOnly;
  const [metricsResult, capabilities, control, inboundResult] = await Promise.allSettled([
    savedOnly || row?.bound === 0 ? Promise.resolve(null) : callRemoteJson(server, env, { path: '/panel/api/server/status', method: 'GET' }),
    !savedOnly && includeCapabilities && row?.bound !== 0 ? callRemoteJson(server, env, { path: '/benx/v1/capabilities', method: 'GET' }) : Promise.resolve(null),
    controlRoute(controlRequest, env, server, ctx).then(r => r.json()),
    readLiveInbounds ? callRemoteJson(server, env, { path: '/panel/api/inbounds/list', method: 'GET' }) : Promise.resolve(null),
  ]);
  const metrics = metricsResult.status === 'fulfilled' ? metricsResult.value : null;
  const validMetrics = metrics && typeof metrics === 'object' && 'cpu' in metrics && Number.isFinite(metrics.cpu);
  const metricsUnavailable = !savedOnly && row?.bound !== 0 && !validMetrics;
  const inbounds = document ? configurationView(document, { path: '/panel/api/inbounds/list', method: 'GET' })
    : inboundResult.status === 'fulfilled' ? inboundResult.value : null;
  const errors = [];
  if (metricsUnavailable) errors.push(document ? 'Live server metrics could not be refreshed. Saved configuration remains available.' : 'Live server metrics could not be refreshed.');
  if (readLiveInbounds && !Array.isArray(inbounds)) errors.push('Live inbounds could not be refreshed.');
  return Response.json({
    status: validMetrics ? metrics : null,
    capabilities: capabilities.status === 'fulfilled' ? capabilities.value : null,
    control: control.status === 'fulfilled' ? control.value : null,
    inbounds: Array.isArray(inbounds) ? inbounds : [],
    inboundsAvailable: Array.isArray(inbounds),
    online: [],
    error: errors.join(' '),
    syncError: control.status === 'rejected' ? 'Synchronization status could not be refreshed.' : '',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
