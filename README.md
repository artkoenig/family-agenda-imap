# Family Agenda IMAP plugin

The IMAP mailbox Source Type (`imap`) of [Family Agenda](https://github.com/artkoenig/family-agenda) as a stateless plugin container. It reads the mails in the folders (on Gmail: labels) an Admin chooses and answers the plugin contract over HTTP. It is built with the plugin kit (`docs/plugin-kit.md` of Family Agenda).

- Read-only: each folder is opened with `EXAMINE` and mails are fetched with `BODY.PEEK`, so no flag is set and no mail is moved or deleted.
- Each allow-listed folder is a Source Attribute, by its `MAILBOXID` where the server has `OBJECTID`, by its name otherwise. On Gmail it reads All Mail once and each allow-listed label is one. A mail is stated again when its folders or labels change, and withdrawn when it is in none. With nothing allow-listed, it reads INBOX.
- A first run reads the last 14 days; later runs continue after the last UID seen (per folder, reset on a new UIDVALIDITY). The sync cursor holds that state.
- Each mail is a raw message (subject and text body, attachments without inline images) for the LLM, dated by when the mailbox received it.
- Configuration (version 4, migrations from 1 to 3 via `configMigration`): `host` (a host field), `port` (993 by default; any other port needs STARTTLS), `username`, `password` (secret), `folders` (choices offered by `fieldChoices` from the live server).

## Running it

In `plugins.yml` of an Instance. The mail server needs no egress entry: `host` is a host field, so the egress proxy allows the server an Admin enters.

```yaml
plugins:
  - id: imap
    image: ghcr.io/artkoenig/family-agenda-imap:0.2.0
```

The image listens on port 8080 and tunnels every IMAP connection through the HTTP CONNECT proxy in `HTTPS_PROXY` (or `https_proxy`) whenever one is set. The proxy always applies: `NO_PROXY` is ignored, as the egress proxy is the container's only way out. TLS is still end to end: the mail server's certificate is verified through the tunnel.

## Developing

Node 26 and pnpm (`corepack enable`). The plugin kit and the plugin contract are git dependencies on Family Agenda, pinned to one commit; raise both together.

- `pnpm install`
- `pnpm check`: typecheck, and the tests against a small in-process IMAP server, including the plugin kit's contract harness
- `pnpm start`: serves the plugin on `PORT` (8080)

## Releasing

Raise `version` in `package.json`, merge, and push the tag `vX.Y.Z` on main. CI then publishes `ghcr.io/artkoenig/family-agenda-imap` as `X.Y.Z` and `X.Y`.

## Licence

AGPLv3 (`LICENSE`). Contributions are licensed inbound as outbound under the [Developer Certificate of Origin](https://developercertificate.org/): sign off every commit (`git commit -s`). See `CONTRIBUTING.md`.
