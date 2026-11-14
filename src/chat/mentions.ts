/**
 * @mentions in group chats. The text stays as written ("@anna"); the sender also puts the
 * mentioned user ids into the (end-to-end encrypted) message ("mn"), so receivers know reliably
 * whether they were meant — even if someone has a nickname. Pure helpers, no React.
 */
export interface MentionMember { id: string; username: string }

const TOKEN = /(^|\s)@([A-Za-z0-9_.-]{1,50})/g;

/** User ids of members mentioned in a text (by username, case-insensitive). */
export function mentionedIds(text: string, members: MentionMember[]): string[] {
  const byName = new Map(members.map((m) => [m.username.toLowerCase(), m.id]));
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const id = byName.get(m[2].toLowerCase());
    if (id) out.add(id);
  }
  return Array.from(out).slice(0, 50);
}

/** The "@prefix" being typed at the end of the draft, or null. */
export function typingMention(draft: string): string | null {
  const m = /(^|\s)@([A-Za-z0-9_.-]{0,50})$/.exec(draft);
  return m ? m[2] : null;
}

/** Replaces the "@prefix" at the end of the draft with the full "@username ". */
export function completeMention(draft: string, username: string): string {
  return draft.replace(/@([A-Za-z0-9_.-]{0,50})$/, `@${username} `);
}

/** Splits a text into plain parts and @mention parts of known members (for highlighting). */
export function splitMentions(text: string, members: MentionMember[]): { text: string; mention?: string }[] {
  const names = new Map(members.map((m) => [m.username.toLowerCase(), m.id]));
  const parts: { text: string; mention?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const id = names.get(m[2].toLowerCase());
    if (!id) continue;
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: '@' + m[2], mention: id });
    last = start + 1 + m[2].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
