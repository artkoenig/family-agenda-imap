/** A mail as the Source Record the LLM reads. */
import type { FetchMessageObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { SourceRecord } from "@family-agenda/plugin-contract";

type Attachment = Extract<SourceRecord["content"], { kind: "raw-message" }>["attachments"][number];

/** The Source Record of a mail, naming no Source Attribute yet; a mail without Message-ID is known by its place. */
export async function recordOf(mail: FetchMessageObject, uidValidity: string, now: Date): Promise<SourceRecord> {
  const parsed = await simpleParser(mail.source ?? Buffer.alloc(0));
  const sender = senderOf(parsed);
  return {
    externalId: parsed.messageId?.trim() || `uid:${uidValidity}:${mail.uid}`,
    occurredAt: receivedAt(mail, parsed, now).toISOString(),
    attributes: [],
    ...shownWith(sender, parsed.subject),
    content: {
      kind: "raw-message",
      text: textOf(parsed),
      attachments: attachmentsOf(parsed),
    },
  };
}

/** When the mailbox received a mail; the Date header is whatever the sender's program wrote. */
function receivedAt(mail: FetchMessageObject, parsed: ParsedMail, now: Date): Date {
  return mail.internalDate ? new Date(mail.internalDate) : (parsed.date ?? now);
}

/** The body of a mail, led by its subject. */
function textOf(parsed: ParsedMail): string {
  const body = (parsed.text ?? "").replace(/\r\n/g, "\n").trim();
  const subject = parsed.subject?.trim();
  return subject ? `Subject: ${subject}\n\n${body}` : body;
}

/** The attachments of a mail, without the images its HTML shows inline. */
function attachmentsOf(parsed: ParsedMail): Attachment[] {
  return parsed.attachments
    .filter((attachment) => !attachment.related)
    .map((attachment) => ({
      filename: attachment.filename ?? "attachment",
      contentType: attachment.contentType,
      bytes: Buffer.from(attachment.content).toString("base64"),
    }));
}

/** The address of the mail's first sender, in lower case, if it names one. */
function senderOf(parsed: ParsedMail): string | null {
  const from: AddressObject | undefined = Array.isArray(parsed.from) ? (parsed.from as AddressObject[])[0] : parsed.from;
  return from?.value[0]?.address?.toLowerCase() ?? null;
}

/** The sender and subject a mail is shown with, those it has. */
function shownWith(sender: string | null, subject: string | undefined): { sender?: string; subject?: string } {
  return { ...(sender ? { sender } : {}), ...(subject?.trim() ? { subject: subject.trim() } : {}) };
}

export function receivedMs(mail: FetchMessageObject): number {
  return mail.internalDate ? new Date(mail.internalDate).getTime() : 0;
}
