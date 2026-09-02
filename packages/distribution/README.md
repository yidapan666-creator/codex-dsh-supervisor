# @yidapan666-creator/dsh-gate

Product installer for [dsh-gate](https://github.com/yidapan666-creator/dsh-gate).

```sh
npx @yidapan666-creator/dsh-gate setup
```

The installer downloads a versioned, checksummed GitHub Release bundle. Use
`--bundle <file> --sha256 <digest>` for an offline installation. Run
`npx @yidapan666-creator/dsh-gate --help` for upgrade and uninstall commands.
Provider credentials are never included in a release; configure one in DSH Web
or provide `DEEPSEEK_API_KEY` before the first model task.
