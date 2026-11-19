#!/usr/bin/env node
/**
 * Local webhook catcher for testing monitor channels without Discord/Slack.
 *
 *   pnpm demo:webhook                # listens on http://localhost:3999
 *   pnpm demo:webhook 4200
 *
 * In the UI (/monitors), point a channel at http://localhost:3999/hook and
 * hit "test" — every notification payload is printed here, pretty-printed.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3999);

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    console.log(`\n${req.method} ${req.url}`);

    try {
      console.log(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      console.log(body || "(empty body)");
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
}).listen(port, () => {
  console.log(`webhook catcher listening on http://localhost:${port} — point channels here`);
});
