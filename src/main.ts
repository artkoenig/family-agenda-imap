/** Runs the IMAP Source as an HTTP plugin on PORT (8080 by default), as its image does. */
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { createImapPlugin } from "./plugin";

const port = Number(process.env.PORT ?? 8080);
// Each call carries its own egress proxy, so the plugin needs none from the environment.
await servePlugin(createImapPlugin(), { port });
console.log(`IMAP Source plugin listening on port ${port}`);
