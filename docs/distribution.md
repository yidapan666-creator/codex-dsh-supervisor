# Distribution and installation

dsh-gate supports three acquisition paths. All converge on the same bootstrap,
doctor, Host lifecycle, supervisor plugin, and exact DSH commit.

| Path | Command | Network during setup | Intended user |
| --- | --- | --- | --- |
| Release installer | `npx @yidapan666-creator/dsh-gate setup` | npm + GitHub Release | Normal users |
| Offline kit | local installer `.tgz` + runtime bundle + checksums | None | Air-gapped or reviewed installs |
| Source checkout | `pnpm bootstrap` | GitHub + npm | Contributors and auditors |

The unrelated unscoped npm name `dsh-gate` is already owned by another
publisher. The official package is therefore `@yidapan666-creator/dsh-gate`;
its installed executable is still `dsh-gate`.

## Release installer

```sh
npx @yidapan666-creator/dsh-gate setup
```

You may instead install the command once with
`npm install --global @yidapan666-creator/dsh-gate`; lifecycle examples below
use `npx` so a global install is never required.

Defaults:

- immutable runtimes: `~/.local/share/dsh-gate/versions/`;
- durable Host/session state: `~/.local/share/dsh-gate/state/`;
- Codex config: `${CODEX_HOME:-~/.codex}/config.toml`;
- personal skill: `${CODEX_SKILLS_DIR:-~/.agents/skills}/codex-dsh-supervisor`;
- Host: `http://127.0.0.1:8080`.

The installer verifies the release SHA-256 before extraction, rejects archive
traversal and escaping symlinks, runs bootstrap, writes one delimited managed
TOML block, starts the Host, and requires live doctor to pass. It never embeds
the Host credential in config; MCP reads the mode-0600 token file.

Provider secrets are deliberately not shipped or copied. A new user must either
launch setup with `DEEPSEEK_API_KEY` in the environment or open DSH Web and save
the provider credential there before the first model task. The installer reports
this as a post-install notice rather than weakening the keyless health check.

```sh
dsh-gate setup --host http://127.0.0.1:18080
dsh-gate setup --no-start
dsh-gate setup --no-config --no-skill
dsh-gate setup --dry-run
```

## Offline bundle

Transfer these three release assets together:

- `yidapan666-creator-dsh-gate-0.1.1.tgz` (the dependency-free installer);
- the matching platform-specific `*-offline.tar.gz` runtime;
- both adjacent `.sha256` files.

Verify both files using the checksums, then run the local installer package.
This command enables npm's offline mode and never contacts the registry:

```sh
npm exec --offline --yes \
  --package ./yidapan666-creator-dsh-gate-0.1.1.tgz -- \
  dsh-gate setup \
  --bundle ./dsh-gate-runtime-0.1.1-linux-x64-offline.tar.gz
```

Offline bundles include built DSH artifacts and the platform dependency tree.
Release construction includes only a sanitized profile template and worker
skill. It never copies `.credentials.yaml`, Host tokens, sessions, workspace
history, or storage records.

## Upgrade and uninstall

```sh
npx @yidapan666-creator/dsh-gate upgrade
npx @yidapan666-creator/dsh-gate upgrade --bundle FILE --sha256 HEX
npx @yidapan666-creator/dsh-gate uninstall
npx @yidapan666-creator/dsh-gate uninstall --purge
```

Runtime versions are staged while `state/` remains stable, so sessions,
recovery capsules, journals, and the Host credential survive upgrades. The old
Host is stopped only after the new bytes and checksum are validated. Bootstrap,
Host health, config, and skill changes form a rollback boundary: failure restores
the previous active runtime, DSH checkout, config, skill, profile link, install
metadata, and managed Host. Prior version runtimes and displaced DSH checkouts
remain available for recovery; successful same-version replacement removes its
temporary staging backup. Normal uninstall removes owned runtime/config/skill
material but retains state; `--purge` removes retained state too.

## Release construction

```sh
pnpm bootstrap
pnpm verify
pnpm dist:bundle:online
pnpm dist:bundle:offline
pnpm dist:pack:npm
```

`.github/workflows/release.yml` builds Linux x64 and macOS arm64 artifacts and
runs isolated install/uninstall E2E against both acquisition modes through the
packed npm CLI. The offline lane disables npm/Corepack network access. A `v*`
tag uploads immutable runtimes, the installer tarball, and all checksums. npm
publishing remains disabled unless `NPM_PUBLISH_ENABLED` is `true` and npm
trusts this exact GitHub workflow; publication then includes npm provenance.
