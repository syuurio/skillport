// Words shared by every command's output.

/** A path shown with ~ for your home folder. */
export const home = (p: string) => p.replace(`${process.env.SKILLPORT_HOME ?? process.env.HOME}/`, "~/");

export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
