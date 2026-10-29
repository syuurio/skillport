# skillport

One place for agent skills, whether they come from a GitHub repo, a vendor's
own installer, an npm package or a folder of your own.

skillport (`skl`) keeps a manifest of your skill sources and installs one copy
of every skill into `~/.agents/skills`, which Codex, Cursor and OpenCode read.
It links them into Claude Code and any other folder you name. Each skill is
named after its source by default (`matt-tdd`), so you can tell where `/tdd`
came from and two sources never collide. You can customize a skill as a patch
that is reapplied on every update.

Design and decisions: [docs/SPEC.md](docs/SPEC.md).

## Commands

```
skl                              the TUI on a terminal, the status table otherwise
skl add <id> --github <owner/repo> | --installer "<command>" | --npm <pkg@ver> --path <dir> | --local <dir>
skl sync [--discard-edits]       make ~/.agents/skills match the manifest and lock (offline)
skl check [source...] [--notify] look for updates; changes no skill
skl status                       what check last found (offline)
skl update [source...] [-i] [--pick] [--discard-edits]   show the plan, then apply it
skl which <name>                 the source, original name and version of an installed skill
skl diff <source>[/<skill>]      what the next update would change on disk
skl edit <source>/<skill> [--drop | --from-disk]   customize a skill as a patch
skl adopt <owner/repo>           take over skills you installed with npx skills
skl remove <source>              remove a source's skills (to trash) and the source
skl secret <source>              store an installer's token in macOS Keychain
skl doctor [--fix]               stray copies, broken or missing links, edits, patches without a note
skl schedule [daily [--at 09:00] | off]   check every day and notify (macOS)
skl migrate [--dry-run]          move a skillport v1 setup to this version
```

`--dry-run` prints the plan only. `-y` skips confirmations. Without a
terminal, a command that writes needs `-y`.

## Manifest

`~/.config/skl/manifest.json` lists your sources. `skl add` writes it, and you
can edit it by hand. It is checked in full every time it is read.

```json
{
  "version": 2,
  "linkTargets": {
    "claude-work": { "label": "Claude Code (work)", "dir": "~/.claude-work/skills" }
  },
  "sources": {
    "matt": { "type": "github", "repo": "mattpocock/skills", "pick": ["tdd", "grilling"] },
    "aiforui": {
      "type": "installer",
      "command": ["npx", "-y", "@aiforui/install@0.1.4", "--token={secret}", "--global"],
      "unattended": ["-y"],
      "secret": "keychain",
      "links": ["claude-code", "claude-work"]
    },
    "motion": { "type": "npm", "package": "motion-ai@14.2.0", "path": "content/skills", "prefix": false },
    "mine": { "type": "local", "path": "~/dev/my-skills" }
  }
}
```

- `github` is downloaded by `npx skills@1.7.0`. It runs in a private HOME,
  so your own `npx skills` setup and its lock are never touched.
- `installer` runs `command` exactly as written, in a sandbox HOME with a
  minimal environment. skl takes only what the installer left in
  `.claude/skills`. `unattended` is appended when no one is at the
  terminal; a source without it runs only with `-i`. `{secret}` comes from
  Keychain (service `skillport`, account = source id).
- `npm` `npm pack`s a pinned package and copies `path` out of it. Nothing in
  the package runs.
- `local` installs from a folder of your own.

Every source can set:

- `prefix`: a custom prefix, or `false` for none. It defaults to the source id.
- `rename`: an install name for one skill.
- `pick`: which skills to install.
- `exclude`: skills to leave out.
- `links`: which targets to link into. The default is `claude-code`
  (`~/.claude/skills`).

New skills upstream are listed by `check` and offered by `update`. They are
never installed on their own.

## Checking every day

`skl schedule daily` adds a launchd agent that runs `skl check --notify` every
day at 09:00 (`--at 21:30` picks another time). When something is new, you
get a macOS notification such as `matt: 2 updates`. The same update is
announced once. The check only asks git, GitHub and npm; no installer runs in
the background, and nothing is installed until you run `skl update`. If your
Mac is asleep at that time, the check runs when it wakes. The job's output
goes to `~/.agents/.skl/schedule.log`. `skl schedule` shows whether it is on,
and `skl schedule off` removes it.

## Customizing a skill

`skl edit matt/tdd` opens the skill in your editor and saves the change as
`~/.config/skl/patches/matt/tdd.patch`, with a note saying why. Updates install
the new upstream version and reapply the patch. When your change and
upstream's touch the same lines, the skill stays as it is and is listed as a
conflict. The merge folder holds `BASE`, `YOURS`, `UPSTREAM` and `MERGED`.
Resolve it in `MERGED`, then run `skl edit matt/tdd` again. If you edited a
skill in `~/.agents/skills` directly, `skl edit matt/tdd --from-disk` turns
that edit into a patch.

## Dotfiles and a new machine

Put only `~/.config/skl/` in your dotfiles: the manifest, patches and notes.
Everything under `~/.agents/.skl/` (lock, store, status) is rebuilt from them,
so leave it out.

On a new machine:

1. Restore `~/.config/skl/`.
2. For each installer source that needs a token, run `skl secret <source>`.
   Keychain does not travel with your dotfiles.
3. Run `skl update -y`. It fetches every source, applies your patches and
   installs. `skl sync` works offline, so it cannot install a source it has
   never fetched. It lists those sources and points you to `skl update`.

A patch made against an older upstream may not apply on the first install.
That skill is held back as a conflict. `MERGED` holds the new upstream plus
every hunk that still applies, and `.rej` files hold the rest. Apply those by
hand, delete the `.rej` files, and run `skl edit <source>/<skill>`.

## Coming from skillport v1

`skl migrate --dry-run` prints what the move would do. Every skill is listed
as `old name -> new name`, and nothing is written. `skl migrate` then does it
after you confirm:

- Installer and npm skills keep their names, and v1's links keep working.
- Skills v1 installed through `npx skills` become a `github` source with
  prefixed names. `npx skills` removes the originals only after you confirm a
  second time.
- Keychain tokens carry over.
- v1's registry and state are kept as `*.v1`.

## Guarantees

- Replaced and removed folders go to `~/.agents/.skl/trash/`. Nothing is
  deleted outright.
- A name already taken by your own `npx skills` install, a folder skl did not
  create, or a link it did not make is never overwritten. Adding a source
  stops before anything is written; a new skill of a source you already have
  is held back and the rest of the update goes ahead.
- Vendor processes get a minimal environment with no shell secrets. Tokens
  live in Keychain and never reach the manifest.
- Skills you changed in place are kept, never overwritten, unless you pass
  `--discard-edits`.

## Development

```
npm test
npx tsc --noEmit
SKILLPORT_HOME=/tmp/sandbox skl status   # relocate every managed path
```
