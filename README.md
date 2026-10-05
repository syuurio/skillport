# skillport

One place for agent skills that vendor installers scatter.

Some skill packs ship through their author's own installer instead of a
marketplace, and those installers copy every skill into every agent folder
they find. skillport runs the installer in a sandbox, installs one copy into
`~/.agents/skills`, links it into Claude Code, and remembers where each skill
came from so you can check for and apply updates.

Design and decisions: [docs/SPEC.md](docs/SPEC.md).

```
skl register <set> [--json '<entry>']   add a set (asks questions, or takes JSON)
skl status                       what is installed, from where (offline)
skl check [set...]               anything new upstream? changes nothing
skl add <set> [-y]               first install (installers ask you which skills unless -y)
skl update [set...] [-i] [-y]    apply upstream changes; -i re-runs the installer interactively
skl diff <set> <skill>           what changed in one skill
skl remove <set>                 trash a set's skills and unregister it
skl resolve <set> <skill> (--prefix [p] | --rename <name> | --exclude | --undo)
skl secret <set>                 store a set's token in macOS Keychain
```

`--dry-run` prints the plan only. `-y` skips confirmations.

## Registry

`~/.config/skillport/registry.json` lists the sets you track:

```json
{
  "version": 1,
  "sets": {
    "aiforui": {
      "type": "installer",
      "command": ["npx", "-y", "@aiforui/install@0.1.4", "--token={secret}", "--global"],
      "unattended": ["-y"],
      "secret": "keychain"
    },
    "motion": { "type": "npm", "package": "motion-ai@14.1.0", "path": "content/skills" }
  }
}
```

- `installer`: runs `command` exactly as written, with `HOME` pointed at a
  sandbox that only contains `.claude/` (`stage`), then takes
  `.claude/skills/*` (`harvest`). Unattended runs append `unattended`; a set
  without it only runs interactively (`-i`) and `update` skips it. skillport
  adds no flags of its own. `{secret}` comes from Keychain (service
  `skillport`, account = set name).
- `npm`: `npm pack`s a pinned package and copies a directory out of it,
  without running it. For installers that refuse to run without a terminal.
- `skills-cli`: delegates to `npx skills` (milestone M2, not implemented yet).

Per set: `skills` (allowlist), `exclude`, `prefix` (offered on collisions),
`rename` (written when you resolve a collision or rename inside the installer).

## Guarantees

- Names are kept as the vendor ships them. A skill is renamed only when it
  collides and you choose to; its folder, frontmatter `name` and the set's
  references to it change together, and the rule is recorded in the registry.
- Updates replace whole folders, so files a vendor deleted do not linger.
- Replaced and removed folders go to `~/.agents/.skillport/trash/`; nothing is
  deleted.
- Collisions with another set, `npx skills`, an unmanaged folder or a link
  skillport did not create stop the run before anything is written.

## Development

```
npm test
npx tsc --noEmit
SKILLPORT_HOME=/tmp/sandbox skl status   # relocate every managed path
```
