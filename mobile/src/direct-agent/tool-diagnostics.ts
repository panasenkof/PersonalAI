/** Provider-neutral boundary: approved Inbox excerpts must never be serialized into
 * diagnostic files, even when optional content logging is enabled.
 * The LLM tool response itself is unchanged; only the diagnostic copy is removed.
 */
export function diagnosticToolResultContent(
  toolName: string, result: unknown,
): Record<string, string> | undefined {
  if (toolName === "list_inbox_for_triage" || toolName === "find_duplicate_candidates") return undefined;
  return { result: JSON.stringify(result) };
}

/** Model's private proposal reasons and tags are equally sensitive: don't
 * preserve model arguments when the optional diagnostic content flag is on. */
export function diagnosticToolArguments(
  name: string, args: unknown,
): Record<string, string> | undefined {
  if (name === "list_inbox_for_triage" || name === "propose_inbox_triage" ||
      name === "find_duplicate_candidates")
    return undefined;
  return { arguments: JSON.stringify(args) || "" };
}
