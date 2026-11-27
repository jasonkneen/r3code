# AGENTS.md

Conventions for automated agents and human contributors working in this
repository. Read this before changing code. `CLAUDE.md` was removed; anything it
carried that still applies lives here.

## What this project is

R3 Code is a native macOS client for agent-assisted development, following the
functionality and interaction design of T3 Code. The client is NSH on GPUI: a
TypeScript UI under `t3ui/` rendered by a native Rust host, plus a Rust server
implementation under `server-rs/`. Work toward upstream parity is ongoing.

## Licensing rules — read before you copy anything

- R3-authored code is **AGPL-3.0-only** (`LICENSE`).
- Material derived from T3 Code **keeps its upstream MIT license** and must be
  listed in `COMPONENT-LICENSES.md`: copied copy/labels, data generated from
  upstream source, matching wire contracts, upstream message catalogs, upstream
  assets.
- Do not relicense T3-derived material as AGPL. If a file you touch carries
  upstream content, add it to `COMPONENT-LICENSES.md` in the same change.
- Do not add internal analysis material: parity gap lists, port strategy,
  reverse-engineering notes, release-tracking runbooks or the server rebuild
  specification set. That material is held outside the published repository.
- Third-party dependencies and vendored code keep their own licenses and
  notices (`LICENSING.md` lists the current set).

## Layout

- `t3ui/` — the client UI (TSX, NSH components, store, pages, shell, desktop
  integration) and its tests next to the code they cover.
- `server-rs/` — the Rust server: `src/`, `tests/`, `migrations/`.
- `tools/` — build, packaging, signing, release and runtime-staging scripts.
- `docs/` — public-facing documentation only.
- `website/` — the product site published to GitHub Pages (includes `llms.txt`).

## Checks

Run the checks that cover what you changed:

```sh
nsh test t3ui/path/to/affected.test.tsx
nsh check t3ui/App.tsx
cargo test -p t3code-server        # from server-rs/, or --workspace at the root
python3 -m unittest discover -s tools -t . -p 'test_*.py'
```

Notes that save time:

- Run Python tool tests from the repository root, not from inside `tools/`;
  a few of them import `tools.*` packages.
- `nsh test` takes one path per invocation; it does not accept multiple files.
- For visual changes, compare the running builds at the same size, theme,
  settings and data. Never describe a source test as visual acceptance.
- After building a platform executable (`.app` or `.exe`), test the built
  binary interactively on the target OS before sign-off; when no target host is
  available, say plainly that live executable testing was not run.

## Building a development bundle

```sh
python3 tools/rebuild_r3_app.py --output "/tmp/R3 Code-build.app"
```

The script builds the native host by default and does not install or launch the
result. `--skip-host-build` reuses the release host and is not a full rebuild.
A staged bundle is ad-hoc signed and is not a notarised distribution.

The rebuild reconstructs the patched host from NSH 0.4.0 plus checksum-pinned
GPUI sources, cached under `build/nsh-host-sources`. To prepare the host
separately, run `python3 tools/prepare_nsh_host.py <checkout>` and pass
`--host-source <checkout>` to the rebuild.

## Working agreements

- Prefer small, reviewable changes; one behaviour change per commit.
- Split fixes strictly into general (cross-platform) fixes and Windows-only
  fixes, using separate commits, branches and PRs rather than mixing them.
- Read the code you are changing before editing, and verify a claim by running
  the command rather than inferring it.
- Keep comments that explain *why*; do not leave stale references to documents
  that no longer exist in this repository.
- Do not commit build output, caches, logs, screenshots or a local relay token.
  `.gitignore` already covers these; if you add a new kind, extend it.
- Do not rewrite published history or force-push shared branches, and do not
  commit a credential of any kind.
- When you cannot run a check, say so plainly in the change description rather
  than implying it passed.

## Documentation

- `README.md` — what R3 Code is and how to build it.
- `CONTRIBUTING.md` — setup, checks, rights and attribution.
- `LICENSING.md` — the licensing scheme and third-party notices.
- `COMPONENT-LICENSES.md` — the per-path list of T3-derived material.
- `docs/RELEASE_READINESS.md` — what is not yet ready for distribution.
- `website/llms.txt` — the machine-readable summary for language models.

## Updating to a new upstream T3 release

Never treat an upstream main branch or nightly tag as the latest stable release.
Resolve the release tag to its commit and record the release URL, publication
date and source hashes. Group changes by UI, protocol, server, providers, data
migrations, build and licensing, then produce a reviewable plan with tests and
open questions. Do not reset, merge into, or overwrite an existing upstream
checkout. Do not present a checked-out source, packaged server or running app as
updated until its own identity and behaviour have been verified.
