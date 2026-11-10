import { ImapFlow, type FetchMessageObject } from "imapflow";
import type { IngestResult, RunContext, SourceRecord } from "@family-agenda/plugin-contract";
import { PluginError, type PluginImplementation } from "@family-agenda/plugin-kit";
import packageJson from "../package.json" with { type: "json" };
import { legacyAttribute, parseCursor, type ContainerState, type Cursor, type Entry } from "./cursor";
import { allMailPath, allowedLabels, gmailLabelChoice, inboxFirst, isGmail } from "./gmail";
import { receivedMs, recordOf } from "./mail";

export type ImapPluginOptions = {
  /**
   * Lets a connection without TLS log in, as to a test server; by default a server on another
   * port than 993 has to offer STARTTLS, so that the password never crosses the network in clear.
   */
  allowPlaintext?: boolean;
  /** How long connecting and each answer may take before the run fails. */
  timeoutMs?: number;
  /**
   * The HTTP CONNECT proxy every connection goes through, such as the egress proxy in
   * `HTTPS_PROXY`; none by default.
   */
  proxy?: string;
};

/** The plugin's own version: that of package.json, raised with each release. */
export const version: string = packageJson.version;

type Config = RunContext["config"];
type Plain = Record<string, unknown>;
type Choice = { value: string; label: string };

/** How far back the first run of a Source reads, so that adding a mailbox does not extract years of mail. */
const firstRunDays = 14;

/** How long a mail's place is remembered; the core ignores older mail on arrival anyway. */
const trackedDays = 180;

const dayMs = 24 * 60 * 60 * 1000;

const defaultPort = 993;

/** Each migration turns the plain configuration of its version into that of the next. */
const migrations: Record<number, (plain: Plain) => Plain> = {
  // The single folder became a list of folders.
  1: ({ folder, ...rest }) => (typeof folder === "string" && folder !== "" ? { ...rest, folders: [folder] } : rest),
  // The folders are typed as a list in one field, as Source Attributes replace the per-Source folder choice.
  2: ({ folders, ...rest }) =>
    Array.isArray(folders) && folders.length > 0 ? { ...rest, folders: folders.filter((name) => typeof name === "string").join(", ") } : rest,
  // The folders are chosen among those the server has, so they are a list again.
  3: ({ folders, ...rest }) => {
    const names = typeof folders === "string" ? commaSeparated(folders) : [];
    return names.length > 0 ? { ...rest, folders: names } : rest;
  },
};

/**
 * Reads the mails in the allow-listed folders of a mailbox, read-only: it opens each folder with
 * `EXAMINE` and fetches with `BODY.PEEK`, so it never sets a flag, and it never moves or deletes a
 * mail. Each allow-listed folder is a Source Attribute, by its `MAILBOXID` where the server has
 * `OBJECTID` and by its name otherwise; on Gmail, which has labels instead, it reads All Mail once
 * and each allow-listed label is one. A mail names the allow-listed folders or labels it is in, and
 * is stated again when they change; one that is in none any more is withdrawn. Everything not
 * allow-listed is dropped here, without a record. With nothing allow-listed, it reads INBOX.
 * Stateless: each call carries the account and the sync cursor.
 */
export function createImapPlugin(options: ImapPluginOptions = {}): PluginImplementation {
  const timeoutMs = options.timeoutMs ?? 60_000;

  /** Creates an IMAP client from the Source's config, validating the address. */
  function mailboxClient(config: Config): ImapFlow {
    const host = stringOf(config.plain.host).trim();
    const port = portOf(config.plain.port);
    if (host === "" || !isPort(port)) {
      throw new PluginError("definite", "The mail server's address or port is not valid.");
    }
    return new ImapFlow({
      host,
      port,
      secure: port === defaultPort,
      doSTARTTLS: port === defaultPort ? undefined : !options.allowPlaintext,
      auth: { user: stringOf(config.plain.username), pass: config.secrets.password ?? "" },
      ...(options.proxy ? { proxy: options.proxy } : {}),
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
  }

  /** Runs `use` on a connection logged in with the Source's account. */
  async function withMailbox<T>(config: Config, use: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = mailboxClient(config);
    // A connection that drops is reported by the command waiting on it.
    client.on("error", () => undefined);
    try {
      try {
        await client.connect();
      } catch (error) {
        throw connectionError(error);
      }
      try {
        return await use(client);
      } catch (error) {
        throw error instanceof PluginError ? error : temporary(error);
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /** The folders, or on Gmail the labels, the mailbox offers to read. */
  function listChoices(config: Config): Promise<Choice[]> {
    return withMailbox(config, async (client) => {
      const mailboxes = (await client.list()).filter((mailbox) => !mailbox.flags.has("\\Noselect"));
      if (!isGmail(client)) return mailboxes.map((mailbox) => ({ value: mailbox.path, label: mailbox.path }));
      const labels = mailboxes.flatMap((mailbox) => {
        const name = gmailLabelChoice(mailbox);
        return name === null ? [] : [name];
      });
      return [...new Set(labels)].sort(inboxFirst).map((name) => ({ value: name, label: name }));
    });
  }

  return {
    description: {
      sourceTypeId: "imap",
      kind: "stateless",
      displayName: { en: "IMAP mailbox", de: "IMAP-Postfach" },
      version,
      description: {
        en: "Reads the mails in the folders (on Gmail: labels) you choose, such as a folder your mail filters fill with school mail, or a mailbox you forward school mail to. It only reads: it never marks, moves or deletes a mail.",
        de: "Liest die Mails in den Ordnern (bei Gmail: Labels), die du auswählst, etwa einem Ordner, den deine Mailfilter mit Schulmails füllen, oder einem Postfach, an das du Schulmails weiterleitest. Es liest nur: Es markiert, verschiebt oder löscht nie eine Mail.",
      },
      needsLlm: true,
      configuration: {
        version: 4,
        fields: [
          {
            key: "host",
            label: { en: "Mail server", de: "Mailserver" },
            secret: false,
            // The egress proxy lets the plugin reach the server an Admin entered here.
            host: true,
            required: true,
            hasChoices: false,
            description: { en: "Such as imap.gmx.net or imap.gmail.com.", de: "Etwa imap.gmx.net oder imap.gmail.com." },
          },
          {
            key: "port",
            label: { en: "Port", de: "Port" },
            secret: false,
            required: false,
            hasChoices: false,
            description: {
              en: "Optional; 993 by default. On another port the server has to offer STARTTLS.",
              de: "Optional; sonst 993. Auf einem anderen Port muss der Server STARTTLS anbieten.",
            },
          },
          {
            key: "username",
            label: { en: "User name", de: "Benutzername" },
            secret: false,
            required: true,
            hasChoices: false,
            description: { en: "Usually the mail address.", de: "Meist die Mailadresse." },
          },
          {
            key: "password",
            label: { en: "Password", de: "Passwort" },
            secret: true,
            required: true,
            hasChoices: false,
            description: {
              en: "An app password where the provider has them, such as for Gmail with 2-Step Verification.",
              de: "Ein App-Passwort, wo der Anbieter welche hat, etwa bei Gmail mit Bestätigung in zwei Schritten.",
            },
          },
          {
            key: "folders",
            label: { en: "Folders", de: "Ordner" },
            secret: false,
            required: false,
            hasChoices: true,
            description: {
              en: "Only the ticked folders (on Gmail: labels) are read; INBOX if none is ticked. Tick folders your mail filters fill with school mail, or a mailbox only school mail is forwarded to: every mail in them is sent to the LLM endpoint. The mail server offers them once the Source is set up.",
              de: "Nur die angehakten Ordner (bei Gmail: Labels) werden gelesen; INBOX, wenn keiner angehakt ist. Hake Ordner an, die deine Mailfilter mit Schulmails füllen, oder ein Postfach, an das nur Schulmails weitergeleitet werden: Jede Mail darin geht an den LLM-Endpunkt. Der Mailserver bietet sie an, sobald die Quelle eingerichtet ist.",
            },
          },
        ],
      },
      setupSteps: [],
      ingestion: { mode: "polling", suggestedIntervalSeconds: 5 * 60 },
      // School mail pauses for weeks in the holidays.
      silentApplies: false,
    },
    poll: (context) => withMailbox(context.config, (client) => pollMailbox(client, context)),
    sourceAttributes: (context) => withMailbox(context.config, (client) => nameFolders(client, context)),
    async fieldChoices({ field, context }) {
      if (field !== "folders") throw new PluginError("definite", `The field "${field}" offers no choices.`);
      return { choices: await listChoices(context.config) };
    },
    configMigration({ fromVersion, plain }) {
      const migrate = migrations[fromVersion];
      if (!migrate) throw new PluginError("definite", `There is no configuration of version ${fromVersion} to migrate.`);
      return { plain: migrate(plain) as typeof plain };
    },
  };
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The port an Admin configured, or the default one when left empty. */
function portOf(value: unknown): number {
  return value === undefined || value === null || value === "" ? defaultPort : Number(value);
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** The names given, trimmed, without empty ones, once each, in their order. */
function uniqueNames(names: unknown[]): string[] {
  return [...new Set(names.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter((name) => name !== ""))];
}

/** The names in a comma- or line-separated text, once each, in their order. */
function commaSeparated(text: string): string[] {
  return uniqueNames(text.split(/[,\n]/));
}

/** The folders, or on Gmail the labels, an Admin allow-listed, in their order; INBOX if none. */
function foldersOf(plain: Record<string, unknown>): string[] {
  const configured = Array.isArray(plain.folders) ? uniqueNames(plain.folders) : commaSeparated(stringOf(plain.folders));
  return configured.length > 0 ? configured : ["INBOX"];
}

/** One container (a folder, or Gmail's All Mail) as this run read it. */
type ContainerRead = {
  /** Its Source Attribute id for a folder, its name for All Mail. */
  key: string;
  path: string;
  state: ContainerState;
  /** What the last run remembered of it, if this run could continue from that. */
  before: Entry[];
  /** The mails read this run, by their external ids. */
  fresh: Map<string, SourceRecord>;
};

type ReadOptions = { gmail: boolean; labels: Set<string>; previous: Cursor | null; now: Date };

async function pollMailbox(client: ImapFlow, context: RunContext): Promise<IngestResult> {
  const now = new Date(context.now);
  const allowed = foldersOf(context.config.plain);
  const gmail = isGmail(client);
  const options: ReadOptions = { gmail, labels: new Set(allowed), previous: parseCursor(context.syncCursor), now };
  const reads: ContainerRead[] = [];
  for (const path of gmail ? [await allMailPath(client)] : allowed) reads.push(await readContainer(client, path, options));

  const declared = gmail ? allowed.map((name) => ({ externalId: name, name })) : reads.map((read) => ({ externalId: read.key, name: read.path }));
  const current = new Set(declared.map((attribute) => attribute.externalId));
  const archived = archivedOf(options.previous, current);

  const before = membership(reads.flatMap((read) => read.before), current);
  const after = membership(reads.flatMap((read) => read.state.entries), current);
  const withdrawn = [...before.keys()].filter((id) => !after.has(id));
  const cursor: Cursor = { v: 2, declared: [...current].sort(), containers: Object.fromEntries(reads.map((read) => [read.key, read.state])) };
  return {
    sourceRecords: await changedRecords(client, reads, before, after, now),
    ...(withdrawn.length > 0 ? { withdrawn } : {}),
    attributes: { declared, archived },
    syncCursor: JSON.stringify(cursor),
  };
}

/**
 * The allow-listed folders, or on Gmail labels, as Source Attributes, named as a run names them but
 * without reading a mail: each folder is only opened for its MAILBOXID.
 */
async function nameFolders(client: ImapFlow, context: RunContext): Promise<{ declared: { externalId: string; name: string }[]; archived: string[] }> {
  const allowed = foldersOf(context.config.plain);
  const gmail = isGmail(client);
  const declared: { externalId: string; name: string }[] = [];
  for (const path of allowed) {
    const externalId = gmail ? path : containerKey(client, path, false, (await openFolder(client, path)).mailboxId);
    declared.push({ externalId, name: path });
  }
  return { declared, archived: archivedOf(parseCursor(context.syncCursor), new Set(declared.map((attribute) => attribute.externalId))) };
}

/** Those the last run declared that are not `current` any more; a Source from before folders were Source Attributes declared one for the whole mailbox. */
function archivedOf(previous: Cursor | null, current: Set<string>): string[] {
  return (previous ? previous.declared : [legacyAttribute]).filter((id) => !current.has(id));
}

/** The mails whose Source Attributes are new or changed, each naming the ones it has now. */
async function changedRecords(client: ImapFlow, reads: ContainerRead[], before: Map<string, string[]>, after: Map<string, string[]>, now: Date): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const [id, attributes] of after) {
    if (before.get(id)?.join("\n") === attributes.join("\n")) continue;
    const record = await recordNaming(client, reads, id, now);
    if (record) records.push({ ...record, attributes });
  }
  return records;
}

/** The Source Attribute ids of each mail, from the entries of the containers still allow-listed. */
function membership(entries: Entry[], current: Set<string>): Map<string, string[]> {
  const byId = new Map<string, Set<string>>();
  for (const entry of entries) {
    const attributes = entry.attributes.filter((id) => current.has(id));
    if (attributes.length === 0) continue;
    const named = byId.get(entry.id) ?? new Set<string>();
    for (const id of attributes) named.add(id);
    byId.set(entry.id, named);
  }
  return new Map([...byId].map(([id, named]) => [id, [...named].sort()]));
}

/** The mail as it was read this run, or read again from where it is now. */
async function recordNaming(client: ImapFlow, reads: ContainerRead[], id: string, now: Date): Promise<SourceRecord | undefined> {
  for (const read of reads) {
    const fresh = read.fresh.get(id);
    if (fresh) return fresh;
  }
  for (const read of reads) {
    const entry = read.state.entries.find((candidate) => candidate.id === id);
    if (!entry) continue;
    await openFolder(client, read.path);
    const [mail] = await client.fetchAll(String(entry.uid), { uid: true, source: true, internalDate: true }, { uid: true });
    return mail ? await recordOf(mail, read.state.uidValidity, now) : undefined;
  }
  return undefined;
}

/**
 * Reads what is new in a container since the last run, and notes which of the mails it remembered
 * are still there and which Source Attributes they name. Only mails naming one are kept: a folder
 * names itself, a Gmail mail names its allow-listed labels.
 */
async function readContainer(client: ImapFlow, path: string, options: ReadOptions): Promise<ContainerRead> {
  const { gmail, labels, previous, now } = options;
  const { uidValidity, mailboxId } = await openFolder(client, path);
  const key = containerKey(client, path, gmail, mailboxId);
  const stored = previous?.containers[key];
  const last = stored?.uidValidity === uidValidity ? stored : undefined;
  const windowStart = now.getTime() - firstRunDays * dayMs;
  const known = last ? last.entries.filter((entry) => entry.at >= now.getTime() - trackedDays * dayMs) : [];
  const floor = await firstUidToList(client, known, last, gmail, windowStart);
  if (!Number.isFinite(floor)) return { key, path, state: { uidValidity, lastUid: highestUid(client), entries: [] }, before: [], fresh: new Map() };

  const listed = await listMails(client, floor, gmail);
  const named = (mail: FetchMessageObject) => (gmail ? allowedLabels(mail.labels, labels) : [key]);
  const sorted = partitionListed(listed, new Map(known.map((entry) => [entry.uid, entry])), named, (mail) => isNewMail(mail, last, windowStart));
  const fresh = await readMails(client, sorted.unread, uidValidity, now);
  const lastUid = Math.max(last?.lastUid ?? 0, ...listed.map((mail) => mail.uid));
  return { key, path, state: { uidValidity, lastUid, entries: [...sorted.entries, ...fresh.entries] }, before: known, fresh: fresh.records };
}

/** A container is known by its Source Attribute id: its `MAILBOXID` where the server has them, else its name; All Mail by its name. */
function containerKey(client: ImapFlow, path: string, gmail: boolean, mailboxId: string | undefined): string {
  return !gmail && mailboxId && client.capabilities.has("OBJECTID") ? mailboxId : path;
}

/**
 * The lowest UID to list: of the mails remembered, after the last one seen, and, on a first read or
 * on Gmail, where a label can be added to a mail of the last days, those of the days a first run reads.
 * Infinity if there is none.
 */
async function firstUidToList(client: ImapFlow, known: Entry[], last: ContainerState | undefined, gmail: boolean, windowStart: number): Promise<number> {
  const recent = !last || gmail ? await uidsSince(client, windowStart) : [];
  return Math.min(...known.map((entry) => entry.uid), ...(last ? [last.lastUid + 1] : []), ...recent);
}

/** The UID, arrival and, on Gmail, labels of every mail from this UID on. */
async function listMails(client: ImapFlow, floor: number, gmail: boolean): Promise<FetchMessageObject[]> {
  const mails = await client.fetchAll(`${floor}:*`, { uid: true, internalDate: true, ...(gmail ? { labels: true } : {}) }, { uid: true });
  // `n:*` names the last mail even when its UID is below n.
  return mails.filter((mail) => mail.uid >= floor);
}

/** Splits the listed mails into those remembered and still naming a Source Attribute, and those new ones that do. */
function partitionListed(
  listed: FetchMessageObject[],
  tracked: Map<number, Entry>,
  named: (mail: FetchMessageObject) => string[],
  isNew: (mail: FetchMessageObject) => boolean,
): { entries: Entry[]; unread: Map<number, string[]> } {
  const entries: Entry[] = [];
  const unread = new Map<number, string[]>();
  for (const mail of listed) {
    const attributes = named(mail);
    const entry = tracked.get(mail.uid);
    if (attributes.length === 0) continue;
    if (entry) entries.push({ ...entry, attributes });
    else if (isNew(mail)) unread.set(mail.uid, attributes);
  }
  return { entries, unread };
}

/** Whether a mail was not seen before: it came after the last UID, or in the days a first run reads. */
function isNewMail(mail: FetchMessageObject, last: ContainerState | undefined, windowStart: number): boolean {
  return (last !== undefined && mail.uid > last.lastUid) || receivedMs(mail) >= windowStart;
}

/** Fetches the mails with these UIDs, and notes each as an entry naming the Source Attributes given. */
async function readMails(
  client: ImapFlow,
  unread: Map<number, string[]>,
  uidValidity: string,
  now: Date,
): Promise<{ records: Map<string, SourceRecord>; entries: Entry[] }> {
  const records = new Map<string, SourceRecord>();
  const entries: Entry[] = [];
  if (unread.size === 0) return { records, entries };
  const sources = await client.fetchAll([...unread.keys()].join(","), { uid: true, source: true, internalDate: true }, { uid: true });
  for (const mail of sources) {
    const record = await recordOf(mail, uidValidity, now);
    records.set(record.externalId, record);
    entries.push({ uid: mail.uid, id: record.externalId, at: receivedMs(mail), attributes: unread.get(mail.uid) ?? [] });
  }
  return { records, entries };
}

async function uidsSince(client: ImapFlow, since: number): Promise<number[]> {
  return (await client.search({ since: new Date(since) }, { uid: true })) || [];
}

/** Opens the folder read-only and returns its UID validity and, if the server has them, its mailbox id. */
async function openFolder(client: ImapFlow, folder: string): Promise<{ uidValidity: string; mailboxId: string | undefined }> {
  try {
    const mailbox = await client.mailboxOpen(folder, { readOnly: true });
    return { uidValidity: mailbox.uidValidity.toString(), mailboxId: mailbox.mailboxId };
  } catch (error) {
    if (isNoResponse(error)) throw new PluginError("definite", `The folder "${folder}" does not exist in the mailbox.`);
    throw temporary(error);
  }
}

/** The highest UID in use in the open folder, 0 if that is unknown. */
function highestUid(client: ImapFlow): number {
  const uidNext = client.mailbox ? client.mailbox.uidNext : NaN;
  return Number.isInteger(uidNext) ? uidNext - 1 : 0;
}

/** A wrong password or a server without the TLS it needs need an Admin; anything else may pass. */
function connectionError(error: unknown): PluginError {
  const details = error as { authenticationFailed?: boolean; code?: string; message?: string };
  if (details.authenticationFailed) return new PluginError("definite", "The mail server refused the user name or password.");
  if (/STARTTLS/i.test(details.message ?? "") || details.code === "NoStartTLS") {
    return new PluginError("definite", "The mail server offers no encrypted connection, so the password is not sent to it.");
  }
  return temporary(error);
}

function isNoResponse(error: unknown): boolean {
  const details = error as { serverResponseCode?: string; responseStatus?: string };
  return details.responseStatus === "NO" || details.serverResponseCode === "NONEXISTENT";
}

/**
 * A failure that may pass. Its message is never passed on, as it may hold a server's reply or the
 * proxy's address; only the error's class and code, which name what went wrong.
 */
function temporary(error: unknown): PluginError {
  const code = (error as { code?: unknown } | null)?.code;
  const kind = [error instanceof Error ? error.name : null, typeof code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : null].filter(Boolean).join(" ");
  return new PluginError("temporary", `The mail server could not be read${kind ? ` (${kind})` : ""}.`);
}
