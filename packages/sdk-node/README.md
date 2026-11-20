# @kinglet/sdk-node

Batching log client for Kinglet. Zero dependencies, Node 26+.

> **Not published to npm yet.** The package lives in `packages/sdk-node` in the
> Kinglet repo. Build it with `pnpm --filter @kinglet/sdk-node build` and use a
> workspace/file dependency until the npm release.

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
(200 events or every 1000ms by default). Failed batches are re-queued
and reported via `onError` — your app never blocks on logging.

## Batching limits

`batchSize` counts events, not bytes. This client does not implement
byte-based batching: a batch of very large events can exceed the server's
request-body limit, which is rejected and re-queued like any other failed
flush. Byte-based batching is an explicit product follow-up, not a hidden
guarantee of this package.
