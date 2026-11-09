/** The sync cursor: what a Source's last run read of each folder, so that the next one goes on from there. */

/** A mail the cursor remembers: where it is (its UID in the container), what it is, when it arrived, whom it names. */
export type Entry = { uid: number; id: string; at: number; attributes: string[] };

/**
 * What was read of one container, a folder or Gmail's All Mail: its UIDVALIDITY, the highest UID
 * seen, and the mails still there that name Source Attributes, so that a move, a changed label or
 * a deletion is noticed.
 */
export type ContainerState = { uidValidity: string; lastUid: number; entries: Entry[] };

/** The sync cursor: what was read of each container, and the Source Attributes this Source declared. */
export type Cursor = { v: 2; declared: string[]; containers: Record<string, ContainerState> };

/** The Source Attribute the whole mailbox was one before its folders became Source Attributes. */
export const legacyAttribute = "mailbox";

/** What the last run remembered, or null if this is the first run or the cursor is from before folders were Source Attributes. */
export function parseCursor(cursor: string | null): Cursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Partial<Cursor>;
    return parsed.v === 2 && Array.isArray(parsed.declared) && parsed.containers ? (parsed as Cursor) : null;
  } catch {
    return null;
  }
}
