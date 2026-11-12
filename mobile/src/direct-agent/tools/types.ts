import type { ToolOutcome } from "../task-state";

export type ToolDefinition = { name: string; description: string; parameters: object };
export type ToolSpec = {
  definition: ToolDefinition;
  effect: "read" | "proposal" | "conversation";
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  verify(result: Record<string, unknown>): ToolOutcome | "state_updated";
};
