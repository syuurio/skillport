import readline from "node:readline/promises";

// Minimal terminal prompts. No dependency: the only interaction skillport
// owns is collision resolution and plan confirmation.

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // readline swallows Ctrl-C by default; exit so staging cleanup runs.
  rl.on("SIGINT", () => process.exit(130));
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  return /^(y|yes|)$/i.test(await ask(`${question} [Y/n] `));
}

export async function choose<T extends string>(
  question: string,
  options: { value: T; label: string; disabled?: string }[],
): Promise<T> {
  console.log(question);
  options.forEach((o, i) =>
    console.log(o.disabled ? `     ${o.label}  (${o.disabled})` : `  ${i + 1}) ${o.label}`),
  );
  for (;;) {
    const n = Number(await ask("> "));
    const o = options[n - 1];
    if (o && !o.disabled) return o.value;
  }
}
