/** Gmail, which has labels instead of folders and lists each label as a folder. */
import type { ImapFlow } from "imapflow";
import { PluginError } from "@family-agenda/plugin-kit";

/** Gmail has labels instead of folders, which it also lists as folders. */
export function isGmail(client: ImapFlow): boolean {
  return client.capabilities.has("X-GM-EXT-1");
}

/**
 * The readable names of Gmail's system labels, by the flag a mail's `X-GM-LABELS` names them with
 * and by the special use their folder is listed with; any other label is named as it is.
 */
const systemLabels: Record<string, string> = {
  "\\Inbox": "INBOX",
  "\\Sent": "Sent",
  "\\Starred": "Starred",
  "\\Flagged": "Starred",
  "\\Important": "Important",
  "\\Draft": "Drafts",
  "\\Drafts": "Drafts",
};

/** The allow-listed labels a mail has, by readable name. */
export function allowedLabels(labels: Set<string> | undefined, allowed: Set<string>): string[] {
  return [...new Set([...(labels ?? [])].map((label) => systemLabels[label] ?? label).filter((name) => allowed.has(name)))];
}

/** The label a Gmail folder listing stands for, if it is one an Admin may read: the Inbox, a user label or a mapped system label. */
export function gmailLabelChoice(mailbox: { path: string; specialUse?: string | undefined }): string | null {
  if (mailbox.path === "INBOX") return "INBOX";
  const mapped = mailbox.specialUse ? systemLabels[mailbox.specialUse] : undefined;
  if (mapped !== undefined) return mapped;
  return mailbox.specialUse || mailbox.path.startsWith("[Gmail]") ? null : mailbox.path;
}

export function inboxFirst(a: string, b: string): number {
  return Number(b === "INBOX") - Number(a === "INBOX");
}

/** The folder holding every mail of a Gmail account. */
export async function allMailPath(client: ImapFlow): Promise<string> {
  const allMail = (await client.list()).find((mailbox) => mailbox.specialUse === "\\All");
  if (!allMail) throw new PluginError("definite", "The Gmail account has no All Mail folder to read.");
  return allMail.path;
}
