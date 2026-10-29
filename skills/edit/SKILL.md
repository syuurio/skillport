---
name: edit
description: Customize an installed agent skill so the change survives upstream updates, by saving it as a skillport patch. Use when the user wants to change, tweak or adjust a skill's instructions or files, or undo such a customization.
---

# Customizing a skill with skillport

Skills in `~/.agents/skills` are installed by skillport (`skl`). A file changed there by hand is overwritten by the next update unless it is saved as a **patch**: skl keeps the patch with a **note** saying why, and reapplies it on every update. You change the installed folder directly, then hand the change to skl. skl keeps the books (the patch, its base version, the lock); change only the skill's files, and leave `~/.config/skl` and `~/.agents/.skl` to skl's commands.

## Steps

1. **Find the skill's id.** Run `skl which <installed name>`. The id is `<source>/<original>` from its output, for example `mattpocock/tdd` for `mattpocock-tdd`. If skl says no installed skill has that name, the skill is not managed by skl: tell the user it cannot be kept as a patch, and stop.

2. **Check its state.** Run `skl status --json` and find the skill's entry under `skills`.
   - `conflict` present: an update is waiting on a merge. Resolve that first with the `skillport-merge` skill.
   - `edited: true`: the folder already has unsaved changes. They become part of the patch you save, so tell the user before you continue.
   - `patch` present: the skill is already customized. Read the file at `note` to learn what the earlier change is for, and keep it.

3. **Make the change** in the folder at `dir`. Leave two kinds of lines exactly as they are: the frontmatter `name`, and any mention of another skill by its installed name. skl writes those itself, so a patch cannot contain them.

4. **Preview the patch.** Run `skl edit <id> --from-disk --dry-run`. It prints the patch against the upstream original and writes nothing. Show it to the user. The patch is against upstream's original names, so it reads `tdd` where the folder says `mattpocock-tdd`.

5. **Save it.** Run `skl edit <id> --from-disk --note "<why>"`. The note is the intent behind the change: what the user wants the skill to do differently, and why. A future merge reads it to decide how the change applies to a new upstream version, so write it for that reader, in a sentence or two. A list of the lines you changed is not a note.

Done when `skl status --json` shows the skill with `patch` and `note` present and `edited: false`.

## When skl refuses

`Could not turn the edits ... into a patch: they touch lines skl rewrites` means step 3 touched the frontmatter `name` or a reference to another skill. Put those lines back as skl wrote them, keep the rest, and save again.

## Undoing a customization

`skl edit <id> --drop` removes the patch and its note (both go to skl's trash) and reinstalls the skill as upstream ships it. Run `skl edit <id> --drop --dry-run` first and confirm with the user.
