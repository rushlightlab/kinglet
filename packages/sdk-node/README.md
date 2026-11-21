# @kinglet/sdk-node

Batching log client for Kinglet. Zero dependencies, Node 24+.

```bash
npm install @kinglet/sdk-node
```

```ts
import { createLogger } from "@kinglet/sdk-node";

const log = createLogger({
  url: "http://localhost:8080", // your Kinglet server
  token: "kl_...", // project key with the ingest scope
  service: "my-app",
  env: "prod",
});

log.info("user signed in", { userId: 42 });
log.error("payment failed", { orderId: 1234, code: "card_declined" });

// best effort on shutdown
await log.close();
```

The configured `service` and `env` are attached to every event as top-level
fields, matching the server's ingest normalizer. Both are omitted when unset.

Events are buffered in-process and shipped as one NDJSON batch
(1000 events or every 1000ms by default). Failed batches are re-queued
and reported via `onError` — your app never blocks on logging. `close()`
waits for a request in flight and drains the buffer.

### Why 1000 events per batch

Most apps never fill a batch: below a few hundred events a second, the
one-second timer flushes first and the batch size changes nothing. It matters
for busy services:

- **Rate limit.** Ingest allows 600 requests per minute per key. At 200 events
  per request that caps one key near 2,000 events/s; at 1,000 it is 10,000,
  about what one Kinglet server can absorb.
- **Server cost.** Each request pays fixed work (auth, parsing, a commit).
  1,000-event batches ingest roughly 25% faster per event than 100-event ones.
- **Outage buffer.** The client keeps up to 10 batches in memory while the
  server is unreachable, so a larger batch also rides out a longer restart.

The trade-off is memory (up to 10,000 buffered events) and, on a hard crash,
losing up to one batch or one second of logs, whichever is smaller. Lower
`batchSize` if your events are large; one request never carries more than 5,000
events.

## Batching limits

`batchSize` counts events, not bytes (maximum 5000). A backlog that builds up
while a request is in flight is sent in chunks of at most 5000 events, below
the server's 10,000-event batch limit. This client does not implement
byte-based batching: a batch of very large events can exceed the server's
request-body limit, which is rejected and re-queued like any other failed
flush. Byte-based batching is an explicit product follow-up, not a hidden
guarantee of this package.
