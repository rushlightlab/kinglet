# @kinglet/sdk-node

Batching log client for Kinglet. Zero dependencies, Node 22+.

```ts
import { createLogger } from "@kinglet/sdk-node";

const log = createLogger({
  url: "http://localhost:8080",   // your Kinglet server
  token: "tok_...",               // from kinglet.token or KINGLET_TOKENS
  service: "my-app",
  env: "prod",
});

log.info("user signed in", { userId: 42 });
log.error("payment failed", { orderId: 1234, code: "card_declined" });

// best effort on shutdown
await log.close();
```

Events are buffered in-process and shipped as one NDJSON batch
(200 events or every 1000ms by default). Failed batches are re-queued
and reported via `onError` — your app never blocks on logging.
