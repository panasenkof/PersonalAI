import type { ChatRow } from "../../direct-agent/conversations";

export type PresentedChatRow = ChatRow & { viewKey: string; streaming?: boolean };
/** UI identity survives the store's separate completion and finally publications.
 * SQLCipher IDs and persistence remain untouched. Never show footer + saved reply.
 */
export function presentChatRows(rows: ChatRow[], busy: boolean, streamText = ""): PresentedChatRow[] {
  let turn = "";
  let answered = false;
  let reply = 0;
  const result = rows.map(row => {
    if (row.role === "user") { turn = row.id; answered = false; reply = 0; }
    if (row.role === "assistant" && turn) {
      answered = true;
      return { ...row, viewKey: `reply:${turn}:${reply++}` };
    }
    return { ...row, viewKey: row.id };
  });
  if (busy && turn && !answered && streamText) {
    result.push({ id: `reply:${turn}:0`, viewKey: `reply:${turn}:0`, role: "assistant", text: streamText, streaming: true } as PresentedChatRow);
  }
  return result;
}
