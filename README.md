# dsh-compaction-threshold

Per-session automatic compaction threshold for DeepSeek Harness, adjustable
from the Web composer while a session runs.

`@deepseek-ai/dsh-compaction-basic` fixes `thresholdRatio` in the agent preset:
one number for every session that preset serves, changeable only by editing YAML
and reloading. This plugin keeps the same trigger arithmetic but lets each
session carry its own ratio, stored durably beside the session log, and shows it
as a chip beside the permission and model chips.

## How it works

Two Loader rows, because a compaction backend and the UI that configures it live
on different planes:

| Row | Plane | Owns |
|---|---|---|
| `dsh-compaction-threshold` | Host | The storage domain keyed by session id, the `compactionThreshold` Session projection, and the `/compaction-threshold` command |
| `dsh-compaction-threshold/engine` | Agent preset (inside the preset's `compaction` group) | The `ctx.compaction` service: `BasicCompactionEngine` with a per-session pressure ratio |

The engine reads the override synchronously from the host service and falls back
to its own configured `thresholdRatio` when the host row is absent, so a
miswired composition degrades to upstream behaviour instead of disabling
compaction. Context-overflow recovery, retention, pruning, retries, and
summarization are inherited from upstream unchanged.

### The threshold formula

Unchanged from upstream (0.1.7-rc.1):

```
thresholdTokens = floor(min(contextWindow × ratio, contextWindow − outputReservation − headroomTokens))
```

Only `ratio` may come from the session. A ratio at or above
`(contextWindow − outputReservation − headroomTokens) / contextWindow` therefore
changes nothing: the capacity cap binds first. The composer menu always shows the
percentage the last request actually resolved to, so an inert setting is visible
rather than silent.

### Why the override lives in a storage domain, not the session log

The Session persistence reader refuses an event type outside the generated
`KNOWN_SESSION_EVENT_TYPES` catalog unless the record carries `ignorable: true`
(`packages/session/session-persistence/src/storage-contract.ts`), and
`Session.append()` has no way to set that marker. A plugin outside this
repository therefore cannot add a Session event: its own logs would stop loading.
The override is non-session application data, so it belongs in
`ctx.storageDomain`, and the client is notified through a Session projection —
which is key-addressed and needs no client code per domain.

## Install

The plugin is plain ESM JavaScript with no build step.

```jsonc
// ~/.dsh/profiles/<profile>/package.json
"dependencies": {
  "dsh-compaction-threshold": "link:C:/resource/dsh-compaction-threshold"
}
```

```sh
cd ~/.dsh/profiles/<profile> && pnpm install     # makes the package resolvable
# restart the host: a new dependency is read at startup, unlike a patch edit
```

Host row, in the profile patch (`cordis.patch.yml`, live-reloaded):

```yaml
- insert:
    - id: compaction-threshold
      name: 'dsh-compaction-threshold'
```

Engine row, replacing `compaction-basic` inside each preset that should become
adjustable (keep `command-compact` and `tool-result-pruner` beside it):

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-threshold
      name: 'dsh-compaction-threshold/engine'
      config:
        thresholdRatio: 0.4        # the value used until a session overrides it
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
```

Source hot reload, in the `hmr` row's `root` list:

```yaml
      - 'C:/resource/dsh-compaction-threshold/index.js'
      - 'C:/resource/dsh-compaction-threshold/engine.js'
      - 'C:/resource/dsh-compaction-threshold/client.js'
      - 'C:/resource/dsh-compaction-threshold/lib/policy.js'
```

## Use

The engine row accepts the same `Config` as `compaction-basic` (`thresholdRatio`,
`headroomTokens`, `retainRatio`/`retainTokens`, `maxTokens`,
`compactionRetries`, `maxOverflowRetries`, `modelPolicies`, `auto`); only
`thresholdRatio` is overridable per session.

The composer chip shows the session's ratio and opens a menu of 30 %–100 % plus
`Preset default`. The same change can be typed:

| Input | Effect |
|---|---|
| `/compaction-threshold` | Report the current ratio, its origin, and the resolved trigger |
| `/compaction-threshold 60` or `60%` | Compact this session once pressure reaches 60 % of its window |
| `/compaction-threshold 0.6` | The same, written as a ratio |
| `/compaction-threshold default` | Drop the override and follow the preset again |

The override applies from the next step and survives restart. It is also
enforced while a turn is running, because it is read at every step boundary.

## Model Experience

### Per-session compaction threshold

#### What the model sees

Nothing directly: the plugin adds no tool and no prompt text. Indirectly it
changes when a `<compacted-summary>` checkpoint replaces older history and how
much recent history stays verbatim, exactly as `compaction-basic` does.

#### Token effect

Lowering a session's ratio compacts earlier and therefore spends fewer prompt
tokens per request at the cost of more summaries; raising it (up to the capacity
cap) compacts later. The summarization request itself is the same one upstream
issues.

#### KV Cache effect

The summarization call reuses the conversation's own prefix, as upstream does.
Changing the ratio never rewrites a request prefix, so it invalidates no
provider cache; it only changes which requests still carry the un-compacted
prefix.

## Verify

```sh
node probe/probe.mjs
```

The probe drives the pure policy module (threshold arithmetic, capacity caps,
range selection, command grammar) without a host.

### Module identity under a source-launched host

```sh
cd C:/resource/deepseek-harness
node --import tsx/esm C:/resource/dsh-compaction-threshold/probe/tsx-identity.mjs
```

A host launched as `node --import tsx/esm apps/cli/src/bin.ts web` maps
`@deepseek-ai/dsh-*` to the repository sources through its tsconfig paths. The
probe proves a plugin outside the checkout resolves the **same** module objects
(`BasicCompactionEngine`, `Service`) as that host, so subclassing the engine and
registering a service keep the host's class identities. Install the plugin as a
`link:` dependency for this to hold in an installed (non-source) host too; a
plugin-local `node_modules` pointing at built `lib/` output would load a second
copy of both classes instead.

### Diagnosing a stored Session's tools

```sh
node probe/session-tools.mjs                 # preset, tool count, shell tools per session
node probe/session-tools.mjs "" 40 --headers # every request/header it recorded
```

Read-only: it decodes the zstd-framed logs under `~/.dsh/sessions` and reports
the selected preset, each `request/header`'s tool names, and the delegation
depth, which is how a session whose agent preset contributed no tools is told
apart from one that never mounted the plugin.

### Browser verification against the dev host

```sh
node probe/dev-ui.mjs http://127.0.0.1:3081/?token=…
node probe/dev-inspect.mjs http://127.0.0.1:3081/?token=…   # DOM/text diagnostics
```

`dev-ui.mjs` drives the installed Edge through the `playwright-core` the primary
profile already carries (no browser download): it dismisses the beta notice,
opens a blank session, changes the ratio from the chip menu, runs turns, and
prints the chip's label and tooltip at each step. Screenshots land in
`.dev-artifacts/`.

What a green run looks like (verified on 2026-09-26 against a dev host):

| Observation | Meaning |
|---|---|
| `before: text="压缩 10%"` | the preset's configured ratio reaches the chip |
| menu lists `跟随预设（10%） 30%…100%` | the projection drives the menu |
| `after choosing 60%: text="压缩 60%"` | command → durable store → projection → chip |
| `after a turn at 60%: title="约在 32K tokens 的 60% 触发"` | the engine resolved the session's ratio and published the real trigger |
| `new session: text="压缩 10%"` | the override is per session |
| `command/done … back to the configured 10%` | the `default` row clears the override |
| `compaction/start` → `compaction/summary` → `compaction/end` in the session log | the pressure branch reached the summarization transaction |
| `compaction/prune` | the same branch prunes first when a pruner is mounted |

### A threshold cannot fix pressure that lives in the tool schemas

Compaction is only attempted when the pressure budget is crossed, and upstream's
transaction refuses a summary that is not smaller than the span it replaces.
When a deployment declares a window barely larger than its own tool catalog, the
pressure sits in the schemas — which no span selection can shadow — so the
engine prunes, tries a summary, and honestly reports
`summary is not smaller than the shadowed content`. A per-session ratio changes
*when* the engine tries; it cannot create headroom that the surface does not
hold. Verified against the shipped backend: 23 of 23 real compactions succeeded
in the primary profile's own sessions, and the refusals appeared only in a
synthetic dev route with a 8k–32k declared window.

## Developing against a dev host

A dev host is required to verify anything the client half renders, and it must
never share the primary host's port. The primary host owns **3080 on all
interfaces**; a second host that inherits the default port tries to bind the same
address, and on Windows that second bind can take the listener away from the
running host — the running host then dies. Boot a dev host only with an explicit
port, and check the port first:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3081 -ErrorAction SilentlyContinue   # expect nothing
```

```powershell
./scripts/dev-host.ps1                      # DSH_HOME + profile + 127.0.0.1:3081 + --no-open
./scripts/dev-host.ps1 -Port 3082           # another free port
```

`scripts/dev-host.ps1` refuses port 3080, refuses a port that is already
listening, refuses `~/.dsh` as `DSH_HOME`, and binds loopback only. The three
isolations it guarantees:

| Resource | Primary host | Dev host |
|---|---|---|
| Port | 3080, `0.0.0.0` (via `dsh-lan-access`) | explicit free port, `127.0.0.1` |
| `DSH_HOME` | `~/.dsh` | `C:\resource\dsh-compaction-threshold-dev-home` |
| Browser | opened by the harness | `--no-open`, so no window steals focus |

Other rules that matter here:

- `--port 0` lets the OS assign a free port, which cannot collide at all; read
  the bound port from the host's startup output.
- `--from-default-profile web` **boots** the profile it initializes; it is not an
  init-only switch. Pass the port flags in that same command.
- A profile's own `cordis.patch.yml` is live-reloaded, but a **new dependency**
  (`link:`) is read at startup, so the dev host needs one restart after
  `dsh plugin --profile ct-dev add …`.
- Keep two trees: `C:\resource\dsh-compaction-threshold` (the tree the primary
  profile links, only ever left at a working commit) and a
  `git worktree` dev copy that only the dev profile links and only `hmr` watches.
- Credentials live per home: copy `.credentials.yaml` into the dev home, or
  export the provider key in the environment before booting.

## Known Limitations and Deferred Work

- **Transcribed upstream policy.** The pressure branch, its formula, and the
  range selection are transcribed from `@deepseek-ai/dsh-compaction-basic`
  0.1.7-rc.1 (`src/config.ts`, `src/index.ts`, `src/region.ts`). Those internals
  are not exported, so an upstream change to them must be mirrored here by hand;
  the probe pins the arithmetic, not the upstream file hashes.
- **The ratio cannot exceed the capacity cap.** With a large output reservation
  or headroom, high percentages are inert; the chip reports the resolved trigger
  so that is visible instead of silent.
- **Overrides are keyed by Session id and never garbage-collected** when a
  Session is deleted. `/compaction-threshold default` clears one session, and
  the whole domain can be dropped by deleting its storage unit file.
- **No storage domain means no persistence.** Without `ctx.storageDomain` the
  override lives in process memory only (the plugin logs one warning); the
  engine keeps working.
- **A preset without the engine row shows no chip**, because no projection is
  published: the chip never offers a switch no backend would honor.
- **The chip renders beside the context meter, not inside it.** The built-in
  meter's popover has no extension slot, so the effective trigger is repeated in
  this chip's own tooltip and menu heading.
