import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

const context = new AsyncLocalStorage();

// Observe only this attempt. No request URL, token, header or body leaves the
// observer. A missing event remains unknown; it is never reported as zero time.
export async function observeTelegramUpload(operation, { report, now = () => performance.now() } = {}) {
  const started = now(), record = {}, requests = new WeakSet();
  const subscriptions = [];
  const subscribe = (name, callback) => {
    const target = channel(name), safeCallback = message => { try { callback(message || {}); } catch {} };
    target.subscribe(safeCallback); subscriptions.push([target, safeCallback]);
  };
  const mark = (key, request) => { if (requests.has(request) && record[key] === undefined) record[key] = now() - started; };
  subscribe("undici:request:create", ({ request }) => { if (request && context.getStore() === record) { requests.add(request); mark("requestCreatedMs", request); } });
  subscribe("undici:client:sendHeaders", ({ request }) => mark("connectionReadyMs", request));
  subscribe("undici:request:bodySent", ({ request }) => mark("bodySentMs", request));
  subscribe("undici:request:headers", ({ request }) => mark("responseHeadersMs", request));
  try { return await context.run(record, operation); }
  finally {
    for (const [target, callback] of subscriptions) target.unsubscribe(callback);
    const elapsedMs = now() - started;
    const difference = (end, begin) => record[end] !== undefined && record[begin] !== undefined ? Math.max(0, record[end] - record[begin]) : null;
    // Connection readiness includes pool waiting, DNS and TLS. It is not an
    // independent DNS/TCP measurement, and reused connections are not relabelled.
    const measurements = { elapsedMs: Math.round(elapsedMs),
      connectionReadyMs: record.connectionReadyMs === undefined ? null : Math.round(record.connectionReadyMs),
      bodyTransferMs: difference("bodySentMs", "connectionReadyMs") === null ? null : Math.round(difference("bodySentMs", "connectionReadyMs")),
      responseWaitMs: difference("responseHeadersMs", "bodySentMs") === null ? null : Math.round(difference("responseHeadersMs", "bodySentMs")),
      responseBodyMs: record.responseHeadersMs === undefined ? null : Math.round(elapsedMs - record.responseHeadersMs),
      waitingForResponseMs: record.bodySentMs !== undefined && record.responseHeadersMs === undefined ? Math.round(elapsedMs - record.bodySentMs) : null };
    try { report?.(measurements); } catch { /* Observability cannot change a delivery result. */ }
  }
}
