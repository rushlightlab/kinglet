# @kinglet/sdk-node

Batching log client for Kinglet. Zero dependencies, Node 26+.

> **Not published to npm yet.** The package lives in `packages/sdk-node` in the
> Kinglet repo. Build it with `pnpm --filter @kinglet/sdk-node build` and use a
> workspace/file dependency until the npm release.

```ts
import { createLogger } from "@kinglet/sdk-node";

const log = createLogger({
  url: "http://localhost:8080",   // your Kinglet server
  token: "kl_...",                // API key with the ingest scope
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
