import type { BakeDirection } from "../../../src/pipeline/bake";

export type ParsedBakeDirectionArgs = {
  direction: BakeDirection;
  remainingArgs: string[];
};

function parseDirection(value: string): BakeDirection {
  if (value === "all" || value === "h" || value === "v") return value;
  throw new Error(`--direction must be one of: all, h, v. Received: ${value}`);
}

export function parseBakeDirectionArgs(args: string[]): ParsedBakeDirectionArgs {
  let direction: BakeDirection = "all";
  const remainingArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--direction") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--direction requires a value: all, h, or v.");
      }
      direction = parseDirection(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--direction=")) {
      direction = parseDirection(arg.slice("--direction=".length));
      continue;
    }
    remainingArgs.push(arg);
  }

  return { direction, remainingArgs };
}
