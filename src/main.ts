/** Runs the IMAP Source as an HTTP plugin on PORT (8080 by default), as its image does. */
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { createImapPlugin } from "./plugin";

const port = Number(process.env.PORT ?? 8080);
// IMAP is no HTTP, so Node's NODE_USE_ENV_PROXY does not apply: the plugin tunnels through the egress proxy itself.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
await servePlugin(createImapPlugin(proxy ? { proxy } : {}), { port });
console.log(`IMAP Source plugin listening on port ${port}`);
