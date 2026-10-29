# skillport v2 plan

skillport v2 manages every agent skill in one place, whether it comes from GitHub through `npx skills`, a vendor installer with a token, an npm package or a local folder.
Every managed skill gets its source id as a prefix by default (`aiforui-color`), so you can tell where a skill came from by its name and two sources never collide.
Customizations are stored as patches and merged three ways when upstream changes.
The rule the program enforces is that a skill's identity is `source/original name`, and the installed name is only derived from it.
Phases run in order, P1 to P11, each tracked by a Linear sub-issue under LAB-12. P4 and P5 can run in parallel, and so can P10 and P11.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

This plan has no PRs and no execution playbook from `playbooks/`. Each phase is worked in this repository on `main`, verified in a sandbox, and committed only after you approve it. The Linear sub-issue for the phase moves to Done at the same time.

A phase is verified only when its unit and live boxes are all checked. Tests alone are not sufficient verification.

## Program checklist

### Before each phase

- [ ] The previous phase is committed and its Linear issue is Done. Evidence is the commit SHA in the issue.
- [ ] `npm test` and `npx tsc --noEmit` pass on `main` before any edit. Evidence is the run output.
- [ ] Move the phase's Linear issue to In Progress.

### After each phase

- [ ] Run `npm test` and `npx tsc --noEmit`. Paste the summary lines.
- [ ] Run the phase's live checks in a sandbox where `SKILLPORT_HOME` points at a fresh folder in the scratchpad. Paste the commands and their output.
- [ ] Show you the diff summary and the live output. Wait for your approval.
- [ ] Commit with a Conventional Commits message. Record the SHA in the Linear issue and move it to Done.

### Sandbox recipe

- [ ] `export SKILLPORT_HOME=$(mktemp -d)` so every managed path lives in the sandbox.
- [ ] Record `shasum ~/.agents/.skill-lock.json` before and after any phase that runs `npx skills`. The two values must match.
- [ ] Delete the sandbox folder after the phase is committed.

## Write SPEC v2 (P1, LAB-13)

**Depends on.** None.

**Files.**

- [ ] Create `docs/SPEC-v2.md`.

**Build.**

- [ ] Write the goals, non-goals, data shapes (`SourceId`, `SkillId`, manifest, lock, store layout, `status.json`, patch and note), each adapter's fetch and check, the output pipeline, the collision rules, the commands and TUI keys, and the prototype evidence from Appendix A.

**You see.**

- [ ] Every data shape has a JSON example, and every collision rule has a concrete example.

**Verify, unit.**

- [ ] No code changes. `npm test` still passes.

**Verify, live.**

- [ ] You read `docs/SPEC-v2.md` and approve it in chat. P2 starts only after that.

**Done.**

- [ ] Commit `docs: add SPEC v2` and close LAB-13.

## Define the core types (P2, LAB-14)

**Depends on.** P1.

**Files.**

- [ ] Create `src/manifest.ts`.
- [ ] Create `src/lock.ts`.
- [ ] Edit `src/registry.ts` to add the v2 paths (`~/.config/skl/manifest.json`, `~/.agents/.skl/lock.json`, `~/.agents/.skl/store/`) next to the v1 ones.
- [ ] Create `test/manifest.test.ts`.

**Build.**

- [ ] Branded `SourceId`, `SkillName` and `SkillId` in `src/manifest.ts`, created only by their parse functions.
- [ ] `Source` as a union discriminated by `type` (`github`, `installer`, `npm`, `local`), sharing `prefix`, `pick`, `exclude` and `rename`.
- [ ] `parseManifest` rejects a duplicated custom prefix, an installed name that breaks the Agent Skills rules or exceeds 64 characters, and a token inside the manifest, reusing the credential checks in `src/validate.ts`.
- [ ] `installedName(id, source)` applies a rename first, then the prefix.
- [ ] `Lock` in `src/lock.ts` records, per `SkillId`, the upstream version, base hash, output hash and installed name.

**You see.**

- [ ] A bad manifest fails with a message that names the source and the field, for example `sources.anidev.prefix "aiforui" is already used by sources.aiforui`.

**Verify, unit.**

- [ ] `test/manifest.test.ts` covers a valid manifest, a duplicated prefix, a 65 character name, a name with `:` or `--`, a token in a command, a default prefix, a custom prefix, `prefix false`, and a rename winning over a prefix. Run `npm test`.

**Verify, live.**

- [ ] No command uses the types yet. `npx tsc --noEmit` passes.

**Done.**

- [ ] Commit `feat(manifest): add v2 manifest and lock types` and close LAB-14.

## Build the store and the output layer (P3, LAB-15)

**Depends on.** P2.

**Files.**

- [ ] Create `src/store.ts`.
- [ ] Create `src/render.ts`.
- [ ] Create `src/adapters/local.ts`.
- [ ] Create `src/sync.ts`.
- [ ] Edit `src/cli.ts` to add `skl sync`.
- [ ] Create `test/render.test.ts` and `test/sync.test.ts`, with fixtures under `test/fixtures/v2/`.

**Build.**

- [ ] `src/store.ts` writes `store/<source>/<skill>/<hash>/` and never changes an existing hash folder.
- [ ] `src/adapters/local.ts` returns every child folder with a `SKILL.md`.
- [ ] `src/render.ts` renames the folder, the frontmatter `name` and references between skills through `src/transform.ts`, and writes `metadata.skl-source` and `metadata.skl-original`.
- [ ] `src/sync.ts` makes `~/.agents/skills` and the target links match the manifest and the lock, replacing whole folders and moving old ones to trash through `src/apply.ts`. It never touches the network.

**You see.**

- [ ] `skl sync` with a local source named `fx` prints each skill as `fx/<name> -> fx-<name>`, and a second run prints `up to date`.

**Verify, unit.**

- [ ] `test/render.test.ts` checks the folder name, the frontmatter, rewritten references and the metadata. Run `npm test`.
- [ ] `test/sync.test.ts` checks that a prefix change moves old names to trash and creates new ones, and that a second sync writes nothing.

**Verify, live.**

- [ ] In the sandbox, add a local source pointing at `test/fixtures/v2/local` and run `skl sync` twice. Paste both outputs.
- [ ] Paste `ls -la` of the sandbox `~/.claude/skills` showing each link pointing at `~/.agents/skills/<name>`.

**Done.**

- [ ] Commit `feat(sync): add the store and the output layer` and close LAB-15.

## Port the installer and npm adapters with skl add (P4, LAB-16)

**Depends on.** P3.

**Files.**

- [ ] Create `src/adapters/installer.ts` and `src/adapters/npm.ts`.
- [ ] Create `src/add.ts`.
- [ ] Edit `src/cli.ts` to route `skl add` to the v2 flow for `--installer`, `--npm` and `--local`.
- [ ] Create `test/adapters.test.ts`.

**Build.**

- [ ] Both adapters reuse the sandbox HOME, minimal environment, Keychain `{secret}` and the refusal of symlinks and special files from `src/acquire.ts` and `src/keychain.ts`, and return only original-name folders.
- [ ] `skl add <id>` writes the manifest entry, asks for a token when the command has `{secret}`, lets you pick skills through `src/select.ts`, then installs.

**You see.**

- [ ] `skl add motion --npm motion-ai@14.1.0 --path content/skills` ends with every skill installed as `motion-<name>`.

**Verify, unit.**

- [ ] `test/adapters.test.ts` runs a fake installer script and checks that only `.claude/skills/*` is taken, the real HOME is untouched, and the token appears in neither the manifest nor any log. Run `npm test`.

**Verify, live.**

- [ ] In the sandbox, run the `skl add motion` command above. Paste the output and `ls` of the sandbox `~/.agents/skills`.

**Done.**

- [ ] Commit `feat(add): add installer and npm sources` and close LAB-16.

## Add the github adapter on a shadow HOME (P5, LAB-17)

**Depends on.** P3.

**Files.**

- [ ] Create `src/adapters/github.ts`.
- [ ] Edit `src/add.ts` to accept `--github <owner/repo>`.
- [ ] Edit `test/adapters.test.ts`.

**Build.**

- [ ] Run `npx skills@1.7.0 add <repo> -g -a codex -s <name>... -y` with `HOME` set to `~/.agents/.skl/cli/<source>/`, then hand `<shadow>/.agents/skills/*` to the store.
- [ ] Record the commit from `git ls-remote <url> HEAD` in the lock.
- [ ] List the available skills with `parseList` from `src/skillscli.ts`.

**You see.**

- [ ] `skl add matt --github mattpocock/skills`, picking `tdd`, ends with `~/.agents/skills/matt-tdd` in the sandbox.

**Verify, unit.**

- [ ] `test/adapters.test.ts` checks that `sandboxEnv` never passes `XDG_STATE_HOME`, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Run `npm test`.

**Verify, live.**

- [ ] In the sandbox, run the command above. Paste the output.
- [ ] Paste the shasum of the real `~/.agents/.skill-lock.json` before and after. The two values match.

**Done.**

- [ ] Commit `feat(add): add github sources through npx skills on a shadow HOME` and close LAB-17.

## Guard against external skills and collisions (P6, LAB-18)

**Depends on.** P4 and P5.

**Files.**

- [ ] Create `src/external.ts`.
- [ ] Create `src/adopt.ts`.
- [ ] Edit `src/sync.ts` to check collisions before writing.
- [ ] Edit `src/doctor.ts` for the v2 checks.
- [ ] Create `test/external.test.ts`.

**Build.**

- [ ] `src/external.ts` reads the real npx skills lock read-only, unowned folders in `~/.agents/skills`, and files or links in target folders that skl did not create.
- [ ] Every installed name across all sources and external skills is checked before any write. A collision stops the run and names both sides and the manifest line to change.
- [ ] `skl adopt <npx skills source>` installs and renders through the shadow HOME first, and only then runs `npx skills remove` on the originals.
- [ ] `skl doctor [--fix]` reports stray copies, broken or missing links, output folders whose hash differs from the lock, and patches without a note. `--fix` only does the safe repairs.

**You see.**

- [ ] A `prefix false` source with `tdd` stops with `tdd collides with an external npx skills install`, and nothing is written.

**Verify, unit.**

- [ ] `test/external.test.ts` covers the collision above and checks that no file changed. Run `npm test`.

**Verify, live.**

- [ ] In the sandbox, install a skill with plain `npx skills` under the sandbox HOME, then run `skl adopt`. Paste the output. The sandbox npx skills lock no longer lists it, and `~/.agents/skills` holds the prefixed copy.
- [ ] Run `skl adopt` again with the network off. The original skill is still there.

**Done.**

- [ ] Commit `feat(adopt): guard external skills and adopt npx skills sources` and close LAB-18.

## Check for updates and report status (P7, LAB-19)

**Depends on.** P6.

**Files.**

- [ ] Create `src/check.ts`.
- [ ] Create `src/status.ts`.
- [ ] Edit `src/cli.ts` to route `skl check`, `skl status` and `skl which` to v2.
- [ ] Create `test/check.test.ts`.

**Build.**

- [ ] `status.json` holds one state per source as a discriminated union of `up-to-date`, `updates`, `pinned-behind`, `unknown`, `error` and `blocked`, plus `customized` and `edited` flags per skill.
- [ ] github sources compare `git ls-remote` with the lock first and call `git/trees/<commit>?recursive=1` only when the commit moved, then link `compare/<old>...<new>`.
- [ ] npm and npm-hosted installers use `npm view`. local sources rehash the folder.
- [ ] `skl status` reads only `status.json`. `skl which <name>` prints the source, original name, version and last update.

**You see.**

- [ ] `skl status` prints one English row per source with its state and how long ago it was checked, even with the network off.

**Verify, unit.**

- [ ] `test/check.test.ts` uses fake ls-remote and tree responses for an unchanged commit (no tree call), a changed skill, a new skill, a removed skill and an unreachable GitHub. Run `npm test`.

**Verify, live.**

- [ ] In the sandbox, run `skl check` then `skl status`. Paste both outputs. Run `skl status` again with the network off and paste it.

**Verify, cost.**

- [ ] Read `https://api.github.com/rate_limit` before and after `skl check`. An unchanged github source costs 0 REST calls and a changed one costs 1. Paste both numbers.

**Done.**

- [ ] Commit `feat(check): cache update status for every source` and close LAB-19.

## Apply updates (P8, LAB-20)

**Depends on.** P7.

**Files.**

- [ ] Create `src/update.ts`.
- [ ] Edit `src/cli.ts` to route `skl update` to v2.
- [ ] Create `test/update.test.ts`.

**Build.**

- [ ] Print the plan per source (replaced, added, removed), then a Held back section for `conflict` and `edited` skills with their next steps (SPEC §11). Held-back skills are never applied and never offered in a selection list.
- [ ] On a terminal, offer a vendor source's unseen new skills in a multiselect before `Apply?`. Unchecked ones go into the lock's `seen`. Without a terminal or with `-y`, only list them and leave `seen` alone. Support `-y`, `--dry-run`, `--pick` and `--discard-edits`.
- [ ] Skip installers that only run interactively unless `-i` is given.
- [ ] Record each source in the lock as soon as it finishes, so a failed run resumes where it stopped.
- [ ] Check collisions again right before writing.

**You see.**

- [ ] After an upstream change to one skill, `skl update` replaces only that folder and the old one is in trash.

**Verify, unit.**

- [ ] `test/update.test.ts` covers a changed skill, a removed skill, an `edited` skill that stays and is held back, a new vendor skill that is offered and not installed with `-y`, a dry run that writes nothing, and a second run that writes nothing. Run `npm test`.

**Verify, live.**

- [ ] In the sandbox, change a file in the local fixture, run `skl check` and `skl update`. Paste the plan and the result. Run `skl update` again and paste `up to date`.

**Done.**

- [ ] Commit `feat(update): apply checked updates` and close LAB-20.

## Keep customizations across updates (P9, LAB-21)

**Depends on.** P8.

**Files.**

- [x] Create `src/patch.ts`.
- [x] Create `src/edit.ts`.
- [x] Edit `src/render.ts` to apply patches before prefixing.
- [x] Edit `src/update.ts` to merge patched skills.
- [x] Create `test/patch.test.ts`.

**Build.**

- [x] `skl edit <source>/<skill>` copies the original-name version to `~/.agents/.skl/work/<source>/<skill>/`, opens `$EDITOR`, saves the diff as `~/.config/skl/patches/<source>/<skill>.patch` and asks for the reason in `<skill>.note.md`.
- [x] The store keeps the base a patch was made against until a merge replaces it.
- [x] On update, run `git merge-file` per file with BASE as the old upstream, UPSTREAM as the new one and YOURS as the old upstream plus the patch. A clean merge regenerates the patch against the new upstream. A conflict marks the skill `conflict`, keeps the old output, and fills `~/.agents/.skl/merge/<source>/<skill>/`.
- [x] `skl edit --drop <source>/<skill>` removes the patch.
- [x] `skl edit --from-disk <source>/<skill>` turns an `edited` skill into a patch: undo skl's own rewrites (installed name, `skl-*` metadata keys, reference rewrites) on a copy of the disk folder, then diff it against the original-name version in the store.

**You see.**

- [x] The update plan shows `patch reapplied` for a clean merge and `conflict` with the merge folder path otherwise.

**Verify, unit.**

- [x] `test/patch.test.ts` covers a clean merge that keeps both changes, a conflict that keeps the old output and fills the merge folder, a prefix change that keeps a patched skill correct, and `--from-disk` producing a patch that renders back to exactly the edited folder. Run `npm test`.

**Verify, live.**

- [x] In the sandbox, run `skl edit`, change the fixture upstream in a different spot, run `skl update`. Paste the plan and the rendered `SKILL.md`. Repeat with an overlapping change and paste the conflict report.

**Done.**

- [x] Commit `feat(edit): keep customizations as patches across updates` and close LAB-21.

## Add v2 skl diff and skl remove (P9.5, LAB-26)

**Depends on.** P9. SPEC §11 lists both, but no phase built them, and P11 deletes the v1 versions.

- [x] `skl diff <source>[/<skill>]` fetches, renders through a dry-run sync, and diffs each folder it would write against the installed one. It writes no skill.
- [x] `skl remove <source>` confirms, trashes the source's skills and links, and drops it from the manifest. Patches, notes and a Keychain token stay. Skills edited in place block it unless `--discard-edits`.
- [x] `test/diff-remove.test.ts`, and live runs on a local source and on `vercel-labs/agent-skills`.

## Build the TUI (P10, LAB-22)

**Depends on.** P9.

**Files.**

- [x] Edit `package.json` to add Ink and React at the versions Context7 confirms.
- [x] Create `src/tui/app.ts` and the panels it needs.
- [x] Edit `src/cli.ts` so `skl` with no arguments opens the TUI on a TTY and prints the status table otherwise.

**Build.**

- [x] Check Ink's current version and API with Context7 before writing code.
- [x] Write the components with `React.createElement`, not JSX, because Node runs `.ts` files directly but refuses `.tsx` (verified on Node 26.13.0).
- [x] The TUI reads `status.json` and calls the same check, plan and update functions as the CLI. Keys are `u`, `U`, `d`, `o`, `space`, `r` and `q`, all labels in English.
- [x] `u` on a blocked source shows the collision, on a source with a bad token sets the token, and an interactive installer gets the terminal while the TUI pauses.

**You see.**

- [x] The source list with the detail panel as drawn in LAB-22, and an update that ends with the source marked up to date.

**Verify, unit.**

- [x] Test the pure parts (rows built from `status.json`, key to action) in `test/tui.test.ts`. Run `npm test`.

**Verify, live.**

- [x] In the sandbox, set up four sources (updates, up to date, blocked, bad token), open `skl`, and save a screenshot of each state to the scratchpad.
- [x] Press `u` on the source with updates. Save screenshots of the plan and the result. The lock matches what `skl update <source>` produces.
- [x] Run `skl | cat` and paste the table.

**Done.**

- [x] Commit `feat(tui): add the status and update TUI` and close LAB-22.

## Migrate from v1 and delete it (P11, LAB-23)

**Depends on.** P9.

**Files.**

- [x] Create `src/migrate.ts`.
- [x] Delete `src/state.ts`, `src/collide.ts`, `src/register.ts`, `src/plan.ts`, the v1 parts of `src/registry.ts` and `src/skillscli.ts`, and their tests.
- [x] Delete `docs/SPEC.md` and rename `docs/SPEC-v2.md` to `docs/SPEC.md`.
- [x] Edit `README.md` for v2, including what goes into dotfiles (`~/.config/skl/` only) and the steps on a new machine (SPEC §5.3).

**Build.**

- [x] `skl migrate [--dry-run]` turns the v1 registry and state into a manifest, lock and store. installer and npm sets keep their ids, `rename` and `namespace`. skills-cli sets become github sources installed on a shadow HOME before their originals are removed. Keychain tokens carry over.
- [x] The plan lists every renamed skill as `old name -> new name`, counts the ones that keep their names, and needs confirmation.
- [x] Remove `skl register`, `skl resolve` and `skl bump`.

**You see.**

- [x] After migration, `skl status` lists every source you had in v1. A skills-cli set with nothing installed (your `pstack`) is listed under Not migrated instead.

**Verify, unit.**

- [x] `test/migrate.test.ts` converts a v1 registry fixture with all three set types. Run `npm test`.

**Verify, live.**

- [x] Copy your real v1 registry and state into the sandbox. Run `skl migrate --dry-run` and `skl migrate`. Paste both.
- [x] Run `rg` for every deleted module name and paste the empty result.
- [ ] On your real machine, run `skl migrate --dry-run` and show you the plan. The real migration runs only after your approval.

**Done.**

- [ ] Commit `feat!: migrate to skillport v2 and remove v1` with a `BREAKING CHANGE` footer and close LAB-23.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] LAB-12 moves to Done with a summary of the commits.
- [ ] LAB-24 and LAB-25 stay in the backlog for after v1.

## Appendix A. Prototype evidence

- A shadow HOME isolates `npx skills`. Running `HOME=<shadow> npx -y skills@1.7.0 add mattpocock/skills -g -a codex -s tdd -y` on 2026-10-29 wrote the lock to `<shadow>/.agents/.skill-lock.json`. The real lock's shasum was the same before and after.
- `git ls-remote https://github.com/mattpocock/skills HEAD` took about 0.7 seconds. Three runs left the GitHub REST core quota at 58 before and after.
- `git/trees/59db609...?recursive=1` returned `skills/engineering/tdd` with sha `667dbdd00c09d0e2189e082986e6a4d61a67c2a6`, equal to the lock's `skillFolderHash`. The response was not truncated.
- `npx skills@1.7.0` updates by running `add <source> --skill <lock key>`, and the installed folder name comes from the frontmatter, read in `dist/cli.mjs`. So a renamed skill cannot stay under the real `npx skills`.
- Node 26.13.0 refuses a `.tsx` file, so the TUI uses `React.createElement`.
- Ink 8.0.0's `useApp().suspendTerminal()` hands the terminal to an interactive installer and repaints after. P10 drove it in a pseudo-terminal: the installer's prompt read the answer from `/dev/tty`, and the TUI came back with the plan. The emulator used (pyte) has no alternate screen, so a real terminal still needs a look.

## Appendix B. Alternatives rejected

- Renaming skills inside the real `npx skills`. Its update would reinstall under the original name or fail, per Appendix A.
- A Claude Code plugin per source for `/source:skill` names. It works only in Claude Code, and the goal is every agent.
- `:` or `/` as the prefix separator. The Agent Skills spec allows only lowercase letters, digits and single hyphens, and `/` is a path separator.
- Fetching GitHub repos without `npx skills`. It would record commits directly, but skl would have to track how `npx skills` discovers skills.
- Interactive collision menus. With prefixes on by default, collisions are rare enough that a clear error is simpler.
- Keeping v1 and v2 side by side. A one-time migration avoids a long-lived compatibility layer.
- A JSX build step for the TUI. One component file does not justify a build in a repository that runs `.ts` directly.

## Appendix C. Risks

- Reference rewriting is text matching and can miss or over-rewrite (P3, P9). The plan output and `skl diff` must show every rewrite.
- `npx skills` output or lock format changes (P5, P7). The version stays pinned at 1.7.0, and the lock reader refuses unknown versions.
- Unauthenticated GitHub API is 60 calls an hour (P7). ls-remote first keeps unchanged sources at zero calls.
- Migration renames every skill you use today (P11). Your own CLAUDE.md, AGENTS.md and notes keep the old names. The dry run lists every rename so you can update them.
- Removing originals during adopt or migrate is a real delete through `npx skills remove` (P6, P11). It runs only after the new copy is rendered.
- Ink and an interactive installer sharing the terminal (P10). Unproven until P10.

## Appendix D. Links and reading list

- Linear parent LAB-12 and sub-issues LAB-13 to LAB-25.
- `docs/SPEC.md` for v1 behavior until P11.
- Agent Skills spec at `https://agentskills.io/specification`.
- `npx skills@1.7.0` source in the local npx cache, `dist/cli.mjs`.
- Architecture and flow diagrams in the scratchpad file `skillport-v2-overview.html`.
