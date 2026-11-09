import { readFileSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginHandler } from "@family-agenda/plugin-kit/server";
import { pluginClient } from "@family-agenda/plugin-kit/testing";
import { describePluginContract } from "@family-agenda/plugin-kit/vitest";
import type { IngestResult, RunContext, SourceRecord } from "@family-agenda/plugin-contract";
import { createImapPlugin, type ImapPluginOptions } from "../src/plugin";
import { ImapServerFixture } from "./imap-server";

const now = new Date("2026-09-14T07:00:00Z");
const days = 24 * 60 * 60 * 1000;

const invitation = `From: Frau Berger <Berger@Schule.example.org>
To: familie@example.org
Subject: Elternabend 5b
Date: Mon, 14 Sep 2026 08:12:00 +0200
Message-ID: <elternabend-1@schule.example.org>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit

Liebe Eltern,

der Elternabend findet am Donnerstag, 17.09., um 19:30 Uhr statt.
--b1
Content-Type: application/pdf; name="einladung.pdf"
Content-Disposition: attachment; filename="einladung.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--b1--
`;

const moved = `From: Frau Berger <berger@schule.example.org>
To: familie@example.org
Subject: Re: Elternabend 5b
Date: Tue, 15 Sep 2026 12:00:00 +0200
Message-ID: <elternabend-2@schule.example.org>
In-Reply-To: <elternabend-1@schule.example.org>
References: <elternabend-1@schule.example.org>
Content-Type: text/html; charset=utf-8

<p>Der Elternabend wird auf <b>16 Uhr</b> verlegt.</p>
`;

const old = `From: verein@example.org
Subject: Saisonabschluss
Date: Sat, 01 Aug 2026 10:00:00 +0200
Message-ID: <alt@example.org>
Content-Type: text/plain

Danke für die Saison!
`;

const account = { user: "familie@example.org", password: "app-password" };
const server = new ImapServerFixture(account);
await server.start();
server.deliver("Schule", old, new Date("2026-08-01T08:00:00Z"));
server.deliver("Schule", invitation, new Date("2026-09-14T06:12:00Z"));
server.deliver("INBOX", "Subject: Privat\n\nNicht für die Schule.\n", new Date("2026-09-14T06:00:00Z"));

const config = (plain: Record<string, unknown> = {}, password = account.password): RunContext["config"] => ({
  plain: { host: "127.0.0.1", port: String(server.port), username: account.user, folders: ["Schule"], ...plain },
  secrets: { password },
});

const plugin = (options: ImapPluginOptions = {}) => pluginClient(createPluginHandler(createImapPlugin({ allowPlaintext: true, ...options })));
type Plugin = ReturnType<typeof plugin>;

/** The Source Attributes declared and not archived, as the core keeps them over a Source's runs. */
function recordingAttributes() {
  const active = new Set<string>();
  return {
    apply(attributes: IngestResult["attributes"]) {
      for (const { externalId } of attributes?.declared ?? []) active.add(externalId);
      for (const id of attributes?.archived ?? []) active.delete(id);
    },
    active: () => [...active],
  };
}

type PollContext = Partial<Omit<RunContext, "now">> & { now?: Date; attributes?: ReturnType<typeof recordingAttributes> };

/** Polls as the core does, over the kit's validating handler; an error answer rejects with its body. */
const pollWith = async (of: Plugin, defaults: RunContext["config"], context: PollContext = {}): Promise<IngestResult> => {
  const { attributes, now: at = now, ...rest } = context;
  const { status, body } = await of("poll", { config: defaults, syncCursor: null, timeZone: "Europe/Berlin", ...rest, now: at.toISOString() });
  if (status !== 200) throw body;
  const result = body as IngestResult;
  attributes?.apply(result.attributes);
  return result;
};

const poll = (context: PollContext = {}, of: Plugin = plugin()): Promise<IngestResult> => pollWith(of, config(), context);

/** The values the folders field offers for a Source of this configuration. */
const folderChoices = async (forConfig: RunContext["config"]) => {
  const context = { config: forConfig, syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin" };
  const { status, body } = await plugin()("fieldChoices", { field: "folders", context });
  if (status !== 200) throw body;
  return (body as { choices: { value: string; label: string }[] }).choices;
};

/** The plain configuration of the next version, as the core migrates one. */
const migrate = async (fromVersion: number, plain: Record<string, unknown>) => {
  const { status, body } = await plugin()("configMigration", { fromVersion, plain });
  if (status !== 200) throw body;
  return (body as { plain: Record<string, unknown> }).plain;
};

const message = (record: SourceRecord | undefined) => {
  if (record?.content.kind !== "raw-message") throw new Error("not a raw message");
  return record.content;
};

describePluginContract(() => createPluginHandler(createImapPlugin({ allowPlaintext: true })), { config: config(), now, languages: ["de"] });

afterAll(async () => {
  await server.stop();
});

describe("the IMAP plugin", () => {
  it("emits each recent mail of its folder as a raw message, with the sender as a Source Record attribute", async () => {
    const { sourceRecords } = await poll();

    expect(sourceRecords).toHaveLength(1);
    const [record] = sourceRecords;
    expect(record).toMatchObject({
      externalId: "<elternabend-1@schule.example.org>",
      occurredAt: "2026-09-14T06:12:00.000Z",
      sender: "berger@schule.example.org",
      subject: "Elternabend 5b",
      attributes: ["Schule"],
    });
    expect(record?.link).toBeUndefined();
    const content = message(record);
    expect(content.text).toBe("Subject: Elternabend 5b\n\nLiebe Eltern,\n\nder Elternabend findet am Donnerstag, 17.09., um 19:30 Uhr statt.");
    expect(content.attachments).toEqual([
      { filename: "einladung.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4\n").toString("base64") },
    ]);
  });

  it("dates a mail by when the mailbox received it, not by the date its sender wrote into it", async () => {
    const backdated = `From: berger@schule.example.org
Subject: Nachtrag
Date: Thu, 10 Sep 2026 08:00:00 +0200
Message-ID: <nachtrag@schule.example.org>
Content-Type: text/plain

Bitte Turnbeutel mitbringen.
`;
    server.deliver("Nachtraege", backdated, new Date("2026-09-14T06:30:00Z"));

    const { sourceRecords } = await poll({ config: config({ folders: ["Nachtraege"] }) });

    expect(sourceRecords.map((record) => record.occurredAt)).toEqual(["2026-09-14T06:30:00.000Z"]);
  });

  it("reads later mails after the last UID it saw", async () => {
    const first = await poll();
    server.deliver("Schule", moved, new Date("2026-09-15T10:00:00Z"));

    const { sourceRecords, syncCursor } = await poll({ syncCursor: first.syncCursor, now: new Date(now.getTime() + days) });

    expect(sourceRecords.map((record) => record.externalId)).toEqual(["<elternabend-2@schule.example.org>"]);
    const content = message(sourceRecords[0]);
    expect(content.text).toContain("Der Elternabend wird auf 16 Uhr verlegt.");
    expect((await poll({ syncCursor })).sourceRecords).toEqual([]);
  });

  it("reads INBOX as the Source itself when no folder is configured", async () => {
    const { sourceRecords } = await poll({ config: config({ folders: undefined }) });

    expect(sourceRecords).toHaveLength(1);
    expect(sourceRecords[0]?.attributes).toEqual(["INBOX"]);
    expect(message(sourceRecords[0]).text).toContain("Nicht für die Schule.");
  });

  it("reads each allow-listed folder, with a sync cursor per folder, and declares one Source Attribute for each", async () => {
    const both = config({ folders: ["Schule", "INBOX"] });
    const declared = recordingAttributes();
    const first = await poll({ config: both, attributes: declared });

    expect([...new Set(first.sourceRecords.map((record) => record.attributes.join()))].sort()).toEqual(["INBOX", "Schule"]);
    expect(declared.active().sort()).toEqual(["INBOX", "Schule"]);
    expect(Object.keys((JSON.parse(first.syncCursor ?? "{}") as { containers: object }).containers).sort()).toEqual(["INBOX", "Schule"]);
    expect((await poll({ config: both, syncCursor: first.syncCursor })).sourceRecords).toEqual([]);
  });

  it("archives a folder that leaves the allow-list and keeps reading the others", async () => {
    const declared = recordingAttributes();
    const first = await poll({ config: config({ folders: ["Schule", "INBOX"] }), attributes: declared });

    const second = await poll({ config: config({ folders: ["Schule"] }), syncCursor: first.syncCursor, attributes: declared });

    expect(declared.active()).toEqual(["Schule"]);
    expect(second.sourceRecords).toEqual([]);
    expect(second.withdrawn ?? []).toEqual([]);
  });

  it("drops what is not allow-listed without a record", async () => {
    const { sourceRecords } = await poll({ config: config({ folders: ["Schule"] }) });

    expect(sourceRecords.length).toBeGreaterThan(0);
    expect(sourceRecords.every((record) => record.attributes.join() === "Schule")).toBe(true);
    expect(sourceRecords.map((record) => record.subject)).not.toContain("Privat");
  });

  it("migrates the single folder of a version 1 configuration into the list of folders", async () => {
    expect(await migrate(1, { host: "h", folder: "Schule" })).toEqual({ host: "h", folders: ["Schule"] });
    expect(await migrate(1, { host: "h", folder: "" })).toEqual({ host: "h" });
  });

  it("migrates the list of folders of a version 2 configuration into one field", async () => {
    expect(await migrate(2, { host: "h", folders: ["Schule", "INBOX"] })).toEqual({ host: "h", folders: "Schule, INBOX" });
    expect(await migrate(2, { host: "h", folders: [] })).toEqual({ host: "h" });
  });

  it("migrates the comma-separated folders of a version 3 configuration into a list of choices", async () => {
    expect(await migrate(3, { host: "h", folders: "Schule, INBOX" })).toEqual({ host: "h", folders: ["Schule", "INBOX"] });
    expect(await migrate(3, { host: "h", folders: "" })).toEqual({ host: "h" });
  });

  it("refuses to migrate a configuration of the current version or newer", async () => {
    await expect(migrate(4, { host: "h" })).rejects.toMatchObject({ kind: "definite" });
  });

  it("marks the mail server as a host field, so that the egress proxy lets the plugin reach it", async () => {
    const { body } = await plugin()("description");
    const fields = (body as { configuration: { fields: { key: string; host?: boolean }[] } }).configuration.fields;

    expect(fields.filter((field) => field.host).map((field) => field.key)).toEqual(["host"]);
  });

  it("only reads, never marking, moving or deleting a mail", async () => {
    server.commands.length = 0;

    const first = await poll();
    await poll({ syncCursor: first.syncCursor });

    expect(server.commands.some((command) => command.startsWith("EXAMINE"))).toBe(true);
    const fetches = server.commands.filter((command) => command.startsWith("UID FETCH"));
    expect(fetches.length).toBeGreaterThan(0);
    const reading = fetches.filter((fetch) => /BODY/i.test(fetch));
    expect(reading.length).toBeGreaterThan(0);
    for (const fetch of reading) expect(fetch).toMatch(/BODY\.PEEK\[\]/i);
    expect(server.commands.filter((command) => /^(SELECT|STORE|UID STORE|COPY|UID COPY|MOVE|UID MOVE|EXPUNGE|UID EXPUNGE|APPEND|DELETE|RENAME|CREATE)\b/.test(command))).toEqual([]);
  });

  it("reads on after the last UID in use when a folder holds nothing recent at first", async () => {
    server.deliver("Archiv", old, new Date("2026-08-01T08:00:00Z"));
    const first = await poll({ config: config({ folders: ["Archiv"] }) });
    expect(first.sourceRecords).toEqual([]);
    server.deliver("Archiv", moved, new Date("2026-09-15T10:00:00Z"));

    const { sourceRecords } = await poll({ config: config({ folders: ["Archiv"] }), syncCursor: first.syncCursor, now: new Date(now.getTime() + days) });

    expect(sourceRecords.map((record) => record.externalId)).toEqual(["<elternabend-2@schule.example.org>"]);
  });

  it("starts over when the folder's UIDVALIDITY changes", async () => {
    const { syncCursor } = await poll();
    const mailbox = server.folders.get("Schule")!;
    mailbox.uidValidity += 1;

    const again = await poll({ syncCursor });

    expect(again.sourceRecords.map((record) => record.externalId)).toContain("<elternabend-1@schule.example.org>");
    mailbox.uidValidity -= 1;
  });

  it("fails definitely on a wrong password or a folder that does not exist", async () => {
    await expect(poll({ config: config({}, "wrong") })).rejects.toMatchObject({ kind: "definite" });
    await expect(poll({ config: config({ folders: ["Nirgends"] }) })).rejects.toMatchObject({ kind: "definite" });
  });

  it("fails temporarily when the server cannot be reached", async () => {
    const error = await poll({ config: config({ port: "1" }) }).catch((thrown: unknown) => thrown);

    // Only the error's class and code reach the core, never a message that may hold a server's reply.
    expect(error).toEqual({ kind: "temporary", message: "The mail server could not be read (Error ECONNREFUSED)." });
  });
});

describe("the IMAP plugin's folders as Source Attributes", () => {
  const mail = (id: string) => `From: a@b.example\nSubject: ${id}\nMessage-ID: <${id}@x.example>\nContent-Type: text/plain\n\nBody ${id}\n`;
  const received = new Date("2026-09-14T06:00:00Z");

  it("names a folder by its MAILBOXID where the server has OBJECTID, so that a rename keeps it", async () => {
    server.deliver("Objekte", mail("o1"), received);
    server.folders.get("Objekte")!.mailboxId = "F42";
    server.capabilities = ["OBJECTID"];
    const declared = recordingAttributes();
    try {
      const first = await poll({ config: config({ folders: ["Objekte"] }), attributes: declared });
      expect(first.sourceRecords.map((record) => record.attributes)).toEqual([["F42"]]);
      expect(declared.active()).toEqual(["F42"]);
    } finally {
      server.capabilities = [];
    }
  });

  it("names a folder by its name where the server has no OBJECTID", async () => {
    server.deliver("Namen", mail("n1"), received);
    server.folders.get("Namen")!.mailboxId = "ignored";

    const { sourceRecords } = await poll({ config: config({ folders: ["Namen"] }) });

    expect(sourceRecords.map((record) => record.attributes)).toEqual([["Namen"]]);
  });

  it("emits a mail moved between allow-listed folders again with the new folder, and withdraws one moved out of all", async () => {
    const uid = server.deliver("Von", mail("m1"), received);
    server.deliver("Nach", mail("m2"), received);
    const both = config({ folders: ["Von", "Nach"] });
    const first = await poll({ config: both });
    expect(first.sourceRecords.find((record) => record.externalId === "<m1@x.example>")?.attributes).toEqual(["Von"]);

    server.move("Von", uid, "Nach");
    const second = await poll({ config: both, syncCursor: first.syncCursor });
    expect(second.sourceRecords.map((record) => [record.externalId, record.attributes])).toEqual([["<m1@x.example>", ["Nach"]]]);
    expect(second.withdrawn ?? []).toEqual([]);

    const moved = server.folders.get("Nach")!.messages.find((message) => message.raw.includes("m1@x.example"))!;
    server.move("Nach", moved.uid, "Papierkorb");
    const third = await poll({ config: both, syncCursor: second.syncCursor });
    expect(third.sourceRecords).toEqual([]);
    expect(third.withdrawn).toEqual(["<m1@x.example>"]);
  });
});

describe("the IMAP plugin on Gmail", () => {
  const gmail = new ImapServerFixture(account);
  const allMail = "[Gmail]/All Mail";
  const mailLabelled = (id: string) => `From: a@b.example\nSubject: ${id}\nMessage-ID: <${id}@g.example>\nContent-Type: text/plain\n\nBody ${id}\n`;
  const at = new Date("2026-09-14T06:00:00Z");
  let uid = 0;
  beforeAll(async () => {
    await gmail.start();
    gmail.capabilities = ["X-GM-EXT-1", "SPECIAL-USE"];
    gmail.deliver(allMail, mailLabelled("unlabelled"), at);
    gmail.folders.get(allMail)!.specialUse = "\\All";
    uid = gmail.deliverLabelled(allMail, ["\\Inbox", "Schule"], mailLabelled("schule"), at);
    gmail.deliverLabelled(allMail, ["Privat"], mailLabelled("privat"), at);
    gmail.deliverLabelled(allMail, ["\\Inbox"], mailLabelled("inbox"), at);
  });
  afterAll(async () => {
    await gmail.stop();
  });
  const gconfig = (folders: string[]): RunContext["config"] => ({
    plain: { host: "127.0.0.1", port: String(gmail.port), username: account.user, folders },
    secrets: { password: account.password },
  });
  const gpoll = (context: PollContext): Promise<IngestResult> => pollWith(plugin(), gconfig(["Schule"]), context);

  it("reads All Mail once and names only the allow-listed labels of a mail", async () => {
    const declared = recordingAttributes();
    const { sourceRecords } = await gpoll({ config: gconfig(["Schule", "Fehlt"]), attributes: declared });

    expect(sourceRecords.map((record) => [record.externalId, record.attributes])).toEqual([["<schule@g.example>", ["Schule"]]]);
    expect(declared.active().sort()).toEqual(["Fehlt", "Schule"]);
  });

  it("calls the Inbox label INBOX and ignores the mails without an allow-listed label", async () => {
    const { sourceRecords } = await gpoll({ config: gconfig(["INBOX", "Schule"]) });

    const named = Object.fromEntries(sourceRecords.map((record) => [record.externalId, record.attributes]));
    expect(named).toEqual({ "<schule@g.example>": ["INBOX", "Schule"], "<inbox@g.example>": ["INBOX"] });
  });

  it("emits a mail again when its labels change, and withdraws it when it has none of the allow-listed ones", async () => {
    const both = gconfig(["INBOX", "Schule"]);
    const first = await gpoll({ config: both });
    gmail.folders.get(allMail)!.messages.find((message) => message.uid === uid)!.labels = ["Schule"];

    const second = await gpoll({ config: both, syncCursor: first.syncCursor });
    expect(second.sourceRecords.map((record) => [record.externalId, record.attributes])).toEqual([["<schule@g.example>", ["Schule"]]]);

    gmail.folders.get(allMail)!.messages.find((message) => message.uid === uid)!.labels = ["Privat"];
    const third = await gpoll({ config: both, syncCursor: second.syncCursor });
    expect(third.sourceRecords).toEqual([]);
    expect(third.withdrawn).toEqual(["<schule@g.example>"]);
  });

  it("offers the Inbox and the user labels as choices, not All Mail or the other system folders", async () => {
    gmail.folders.set("INBOX", { uidValidity: 1, messages: [] });
    gmail.folders.set("Schule", { uidValidity: 1, messages: [] });
    gmail.folders.set("[Gmail]/Spam", { uidValidity: 1, messages: [], specialUse: "\\Junk" });

    const choices = await folderChoices(gconfig([]));

    expect(choices).toEqual([
      { value: "INBOX", label: "INBOX" },
      { value: "Schule", label: "Schule" },
    ]);
  });
});

describe("the IMAP plugin's choice of folders", () => {
  it("offers the folders of the live server", async () => {
    const choices = await folderChoices(config());

    expect(choices.map((choice) => choice.value)).toEqual(expect.arrayContaining(["INBOX", "Schule"]));
  });

  it("offers no choices for another field", async () => {
    const context = { config: config(), syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin" };
    const { status, body } = await plugin()("fieldChoices", { field: "host", context });

    expect(status).toBe(422);
    expect(body).toMatchObject({ kind: "definite" });
  });
});

describe("the IMAP plugin's connection", () => {
  const tlsOnly = pluginClient(createPluginHandler(createImapPlugin()));

  it("never sends the password unencrypted to a server that offers no TLS", async () => {
    server.commands.length = 0;

    await expect(poll({}, tlsOnly)).rejects.toMatchObject({ kind: "definite" });
    expect(server.commands).not.toContain("LOGIN ***");
  });
});

/** An HTTP CONNECT proxy, as the egress proxy is, that notes where each tunnel goes. */
async function connectProxy() {
  const tunnels: string[] = [];
  const sockets = new Set<Socket>();
  const proxy: Server = createServer((client) => {
    sockets.add(client);
    client.once("data", (head) => {
      const target = /^CONNECT (\S+) HTTP/.exec(head.toString())?.[1] ?? "";
      tunnels.push(target);
      const [host = "", port = ""] = target.split(":");
      const upstream = connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, tunnels, close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

describe("the IMAP plugin behind the egress proxy", () => {
  it("tunnels its connection to the mail server through the proxy it is given", async () => {
    const proxy = await connectProxy();
    try {
      const { sourceRecords } = await poll({}, plugin({ proxy: proxy.url }));

      expect(sourceRecords.map((record) => record.externalId)).toContain("<elternabend-1@schule.example.org>");
      expect(proxy.tunnels).toEqual([`127.0.0.1:${server.port}`]);
    } finally {
      await proxy.close();
    }
  });

  it("still verifies the mail server's certificate through the tunnel, refusing one it cannot trust", async () => {
    const proxy = await connectProxy();
    const untrusted = await startTlsServer();
    try {
      const plain = { host: "127.0.0.1", port: String(untrusted.port), username: account.user, folders: ["INBOX"] };
      const error = await pollWith(plugin({ proxy: proxy.url, allowPlaintext: false }), { plain, secrets: { password: account.password } }).catch((thrown: unknown) => thrown);

      expect(untrusted.upgraded()).toBe(true);
      expect(error).toMatchObject({ kind: "temporary", message: expect.stringContaining("SELF_SIGNED") });
      expect(proxy.tunnels).toEqual([`127.0.0.1:${untrusted.port}`]);
      expect(untrusted.commands).not.toContainEqual(expect.stringMatching(/^LOGIN/));
    } finally {
      await untrusted.close();
      await proxy.close();
    }
  });
});

/**
 * An IMAP server that offers STARTTLS with a self-signed certificate for 127.0.0.1, which no client
 * may trust, and notes each command it reads after the upgrade.
 */
async function startTlsServer() {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  let upgraded = false;
  const imap: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.write("* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] ready\r\n");
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
        const [tag, command = ""] = line.split(" ");
        if (/^STARTTLS$/i.test(command)) {
          socket.off("data", onData);
          socket.write(`${tag} OK Begin TLS negotiation now\r\n`);
          upgraded = true;
          const secure = new TLSSocket(socket, { isServer: true, key: fixture("self-signed.key"), cert: fixture("self-signed.crt") });
          secure.on("error", () => socket.destroy());
          secure.on("data", (data: Buffer) => commands.push(...data.toString().split("\r\n").filter(Boolean).map((next) => next.split(" ").slice(1).join(" "))));
          return;
        }
        if (/^CAPABILITY$/i.test(command)) socket.write(`* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r\n${tag} OK done\r\n`);
        else socket.write(`${tag} BAD not before TLS\r\n`);
      }
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => imap.listen(0, "127.0.0.1", resolve));
  return {
    port: (imap.address() as { port: number }).port,
    commands,
    upgraded: () => upgraded,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => imap.close(() => resolve()));
    },
  };
}
