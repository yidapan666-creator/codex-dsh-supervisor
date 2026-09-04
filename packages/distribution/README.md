# @yidapan666/dsh-gate

Compatibility package and lifecycle CLI for [Codex DSH Supervisor](https://github.com/yidapan666-creator/codex-dsh-supervisor).

The npm package and installed `dsh-gate` command keep their existing names so
current installations and automation continue to work.

```sh
npx @yidapan666/dsh-gate setup
```

The installer downloads a versioned, checksummed GitHub Release bundle. Use
`--bundle <file> --sha256 <digest>` for an offline installation. Run
`npx @yidapan666/dsh-gate --help` for upgrade and uninstall commands.
Provider credentials are never included in a release; configure one in DSH Web
or provide `DEEPSEEK_API_KEY` before the first model task.

`npx` runs the current published package without a global install. A global
`npm install --global @yidapan666/dsh-gate` remains on its installed version
until updated. Both release-based routes use the matching versioned GitHub
runtime; they do not silently install unreleased commits from `main`. An offline
installer and runtime bundle must also have the same version.
