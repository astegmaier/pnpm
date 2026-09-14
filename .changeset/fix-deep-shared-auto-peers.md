---
"@pnpm/installing.deps-resolver": patch
"pnpm": patch
---

`pnpm install` now installs required transitive peers found only in deeper workspace dependency occurrences when `autoInstallPeers` is enabled [pnpm/pnpm#14840](https://github.com/pnpm/pnpm/issues/14840).
