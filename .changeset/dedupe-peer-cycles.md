---
"@pnpm/installing.deps-resolver": patch
"pnpm": patch
---

Fixed `dedupePeerDependents` failing to merge two snapshots of the same package when there is a peer-dependency cycle between two packages and one of them activates an optional transitive peer only in some workspace projects (e.g., `webpack` ↔ `terser-webpack-plugin` with optional `esbuild`) [#11834](https://github.com/pnpm/pnpm/issues/11834).
