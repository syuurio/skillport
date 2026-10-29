import * as p from "@clack/prompts";

// Terminal prompts, built on @clack/prompts (arrow keys, inline validation).
// Every prompt treats Ctrl-C / Esc as "stop now": it exits with 130 so the
// staging cleanup registered in cli.ts runs.

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
  }
}

function settle<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    throw new Cancelled();
  }
  return value as Exclude<T, symbol>;
}

export async function ask(
  message: string,
  opts: { placeholder?: string; initial?: string; validate?: (v: string) => string | undefined } = {},
): Promise<string> {
  const value = await p.text({
    message,
    placeholder: opts.placeholder,
    initialValue: opts.initial,
    validate: opts.validate ? (v) => opts.validate!((v ?? "").trim()) : undefined,
  });
  return settle(value).trim();
}

export async function confirm(message: string, initial = true): Promise<boolean> {
  return settle(await p.confirm({ message, initialValue: initial }));
}

export async function chooseMany<T extends string>(
  message: string,
  options: { value: T; label: string; hint?: string }[],
  initial: T[],
  required = false,
): Promise<T[]> {
  const value = await p.multiselect<T>({
    message,
    options: options as Parameters<typeof p.multiselect<T>>[0]["options"],
    initialValues: initial,
    required,
  });
  return settle(value);
}
