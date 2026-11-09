import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export type FixtureMessage = { uid: number; internalDate: Date; raw: string; labels?: string[] };

export type FixtureMailbox = {
  uidValidity: number;
  messages: FixtureMessage[];
  /** Its RFC 8474 id, sent when the server has the `OBJECTID` capability. */
  mailboxId?: string;
  /** Its special use, such as `\\All` for Gmail's All Mail. */
  specialUse?: string;
};

/**
 * A small IMAP server for the plugin's contract tests: one account, folders of fixed messages, and
 * only the commands a reading client needs. It records every command, so that a test can show the
 * plugin never changes the mailbox.
 */
export class ImapServerFixture {
  /** Every command received, without its tag, passwords masked. */
  readonly commands: string[] = [];
  readonly folders = new Map<string, FixtureMailbox>();
  /** What the server offers besides IMAP4rev1, such as `OBJECTID` or Gmail's `X-GM-EXT-1`. */
  capabilities: string[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly account: { user: string; password: string }) {}

  get port(): number {
    return (this.server?.address() as AddressInfo).port;
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      this.serve(socket);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const { server } = this;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  /** Adds a message to a folder with the next UID. */
  deliver(folder: string, raw: string, internalDate: Date): number {
    const mailbox = this.folders.get(folder) ?? { uidValidity: 1, messages: [] };
    this.folders.set(folder, mailbox);
    const uid = (mailbox.messages.at(-1)?.uid ?? 0) + 1;
    mailbox.messages.push({ uid, internalDate, raw: raw.replace(/\r?\n/g, "\r\n") });
    return uid;
  }

  /** Adds a message to a folder with the next UID, under Gmail labels. */
  deliverLabelled(folder: string, labels: string[], raw: string, internalDate: Date): number {
    const uid = this.deliver(folder, raw, internalDate);
    this.folders.get(folder)!.messages.find((message) => message.uid === uid)!.labels = labels;
    return uid;
  }

  /** Removes a message from a folder, as a move out of it or a deletion does. */
  expunge(folder: string, uid: number): void {
    const mailbox = this.folders.get(folder)!;
    mailbox.messages = mailbox.messages.filter((message) => message.uid !== uid);
  }

  /** Moves a message to another folder, where it gets the next UID. */
  move(from: string, uid: number, to: string): number {
    const message = this.folders.get(from)!.messages.find((candidate) => candidate.uid === uid)!;
    this.expunge(from, uid);
    return this.deliver(to, message.raw, message.internalDate);
  }

  private serve(socket: Socket): void {
    let buffer = "";
    let selected: FixtureMailbox | null = null;
    let authenticated = false;
    const send = (line: string) => socket.write(`${line}\r\n`);
    const capability = () => ["IMAP4rev1", ...this.capabilities].join(" ");
    send(`* OK [CAPABILITY ${capability()}] Fixture ready`);

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const match = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!match) continue;
        const [, tag, rawCommand, args = ""] = match as unknown as [string, string, string, string?];
        let command = rawCommand.toUpperCase();
        let rest = args;
        if (command === "UID") {
          const [sub, ...more] = rest.split(" ");
          command = `UID ${sub?.toUpperCase()}`;
          rest = more.join(" ");
        }
        this.commands.push(command === "LOGIN" ? "LOGIN ***" : `${command}${rest ? ` ${rest}` : ""}`);
        const ok = (text = `${command} completed`) => send(`${tag} OK ${text}`);

        switch (command) {
          case "CAPABILITY":
            send(`* CAPABILITY ${capability()}`);
            ok();
            break;
          case "NOOP":
            ok();
            break;
          case "LOGIN": {
            const [user, password] = atoms(rest);
            authenticated = user === this.account.user && password === this.account.password;
            if (authenticated) ok(`[CAPABILITY ${capability()}] LOGIN completed`);
            else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
            break;
          }
          case "LIST": {
            const [, pattern = ""] = atoms(rest);
            if (pattern === "") send('* LIST (\\Noselect) "/" ""');
            for (const [name, mailbox] of this.folders) {
              const flags = ["\\HasNoChildren", ...(mailbox.specialUse ? [mailbox.specialUse] : [])].join(" ");
              if (pattern === "*" || pattern === name) send(`* LIST (${flags}) "/" "${name}"`);
            }
            ok();
            break;
          }
          case "SELECT":
          case "EXAMINE": {
            const [name = ""] = atoms(rest);
            const mailbox = authenticated ? this.folders.get(name) : undefined;
            if (!mailbox) {
              send(`${tag} NO [NONEXISTENT] Unknown mailbox`);
              break;
            }
            selected = mailbox;
            send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
            send(`* ${mailbox.messages.length} EXISTS`);
            send("* 0 RECENT");
            send(`* OK [UIDVALIDITY ${mailbox.uidValidity}] UIDs valid`);
            send(`* OK [UIDNEXT ${(mailbox.messages.at(-1)?.uid ?? 0) + 1}] Predicted next UID`);
            if (mailbox.mailboxId && this.capabilities.includes("OBJECTID")) send(`* OK [MAILBOXID (${mailbox.mailboxId})] Ok`);
            ok(command === "EXAMINE" ? "[READ-ONLY] EXAMINE completed" : "[READ-WRITE] SELECT completed");
            break;
          }
          case "UID SEARCH": {
            if (!selected) {
              send(`${tag} BAD No mailbox selected`);
              break;
            }
            const since = /SINCE (\d{1,2}-\w{3}-\d{4})/i.exec(rest)?.[1];
            const from = since ? new Date(`${since} 00:00:00 UTC`) : null;
            const uids = selected.messages.filter((message) => !from || message.internalDate >= from).map((m) => m.uid);
            send(`* SEARCH${uids.map((uid) => ` ${uid}`).join("")}`);
            ok();
            break;
          }
          case "UID FETCH": {
            if (!selected) {
              send(`${tag} BAD No mailbox selected`);
              break;
            }
            const [range = "", ...items] = rest.split(" ");
            const wanted = items.join(" ").toUpperCase();
            const messages = selected.messages;
            const matching = inRange(range, messages.map((message) => message.uid));
            messages.forEach((message, index) => {
              if (!matching.includes(message.uid)) return;
              const parts = [`UID ${message.uid}`];
              if (wanted.includes("INTERNALDATE")) parts.push(`INTERNALDATE "${internalDateOf(message.internalDate)}"`);
              if (wanted.includes("X-GM-LABELS")) parts.push(`X-GM-LABELS (${(message.labels ?? []).map((label) => `"${label.replace(/\\/g, "\\\\")}"`).join(" ")})`);
              let literal = "";
              if (wanted.includes("BODY.PEEK[HEADER.FIELDS (FROM)]")) {
                const header = (/^From:.*$/im.exec(message.raw)?.[0] ?? "") + "\r\n\r\n";
                parts.push(`BODY[HEADER.FIELDS (FROM)] {${Buffer.byteLength(header)}}`);
                literal = header;
              } else if (wanted.includes("BODY.PEEK[]") || wanted.includes("BODY[]")) {
                parts.push(`BODY[] {${Buffer.byteLength(message.raw)}}`);
                literal = message.raw;
              }
              if (literal) socket.write(`* ${index + 1} FETCH (${parts.join(" ")}\r\n${literal})\r\n`);
              else send(`* ${index + 1} FETCH (${parts.join(" ")})`);
            });
            ok();
            break;
          }
          case "LOGOUT":
            send("* BYE Logging out");
            ok();
            socket.end();
            break;
          default:
            send(`${tag} BAD ${command} is not supported here`);
        }
      }
    });
  }
}

/** The quoted strings and atoms of a command's arguments. */
function atoms(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) =>
    match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? ""),
  );
}

/** The UIDs a sequence set such as `5:*` or `1,3:4` names, of those there are. */
function inRange(range: string, uids: number[]): number[] {
  const highest = uids.at(-1) ?? 0;
  const value = (text: string) => (text === "*" ? highest : Number(text));
  return uids.filter((uid) =>
    range.split(",").some((part) => {
      const [first = "", last = first] = part.split(":");
      const [low, high] = [value(first), value(last)].sort((a, b) => a - b) as [number, number];
      return uid >= low && uid <= high;
    }),
  );
}

/** A date as IMAP's INTERNALDATE gives it, such as `14-Sep-2026 06:12:00 +0000`. */
function internalDateOf(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}
