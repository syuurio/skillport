---
name: merge
description: Resolve a skillport merge conflict, where a customized skill's patch and an upstream update changed the same lines. Use when skl reports a conflict, an update is held back, or the user asks to merge or finish a skill update.
---

# Resolving a skillport merge

A customized skill has a **patch** with a **note** saying why. When upstream changes the same lines, skl holds the update back and lays out a merge folder. Your job is to write, in its `MERGED/` folder, the new upstream version with the user's intent carried over; skl then saves the patch and installs the result. Change files only inside `MERGED/`, and leave the rest of skl's folders to skl's commands.

## Steps

1. **Find the conflict.** Run `skl status --json`. Each skill with a `conflict` entry is waiting; its `id` is `<source>/<original>`, and `conflict.dir` is the merge folder. If the user named a skill, take that one; otherwise list them and work through each in turn.

2. **Read the intent.** In the merge folder:
   - `note.md` is why the user customized the skill. It is the authority on intent. When it is missing, the intent has to come from the user: ask them before going on.
   - `your.patch` is the user's change, against the old upstream.
   - `UPSTREAM/` is the new upstream version. Diff it against `BASE/` (the old upstream) to see what upstream changed and why.
   - `YOURS/` is the old upstream with the user's patch, when present.
   - `MERGED/` is the starting point: upstream with every part of the patch that still applied. A file that could not be merged line by line has `<<<<<<< YOURS` / `>>>>>>> UPSTREAM` markers; a patch that no longer applied leaves its hunks in `.rej` files beside the file.

   Everything in the merge folder uses upstream's names: `tdd`, not `mattpocock-tdd`.

3. **Decide the outcome**, one of three:
   - **Merge**: the intent still applies to the new upstream. Edit `MERGED/` until it is the new upstream plus the intent: resolve every conflict marker, carry each `.rej` hunk over by hand, then delete the `.rej` files. Take upstream's wording and structure wherever the note does not ask for something different.
   - **Drop**: upstream now does what the note asked for, so the patch has no job left. Tell the user and, once they agree, run `skl edit <id> --drop`.
   - **Ask**: the note does not settle it, or upstream's change works against the intent. Stop and put the choice to the user, quoting the lines from both sides.

4. **Preview the merge.** Run `skl edit <id> --dry-run`. It prints the patch that would be saved against the new upstream and writes nothing. Show it to the user. Every hunk in it should trace back to the note; a hunk that does not is a leftover from the old upstream, so take upstream's version of it in `MERGED/` and preview again.

5. **Finish it.** Run `skl edit <id>`. Add `--note "<why>"` only when the merge changed what the customization is for.

Done when `skl status --json` shows the skill without `conflict`, with its `dir` present, and `skl edit` printed the skill being installed.

## When skl refuses

- `Apply the hunks in ... by hand`: `.rej` files are still in `MERGED/`. Carry their hunks over and delete them.
- `Resolve the conflict markers in ...`: a marker line is still in a file in `MERGED/`.
- `was changed in place`: the installed folder has unsaved changes. Ask the user whether to keep them (the `skillport-edit` skill saves them) or discard them (`skl sync --discard-edits`) before finishing the merge.
