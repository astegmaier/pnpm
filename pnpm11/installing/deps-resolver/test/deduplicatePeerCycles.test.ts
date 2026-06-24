import { expect, test } from '@jest/globals'
import type { DepPath, PkgIdWithPatchHash, PkgResolutionId } from '@pnpm/types'

import {
  deduplicateAll,
  type GenericDependenciesGraphWithResolvedChildren,
  type PartialResolvedPackage,
} from '../lib/resolvePeers.js'

type Node = GenericDependenciesGraphWithResolvedChildren<PartialResolvedPackage>[DepPath]

function makeNode (
  name: string,
  pkgIdWithPatchHash: string,
  children: Record<string, DepPath>,
  resolvedPeerNames: string[] = []
): Node {
  return {
    name,
    version: '1.0.0',
    pkgIdWithPatchHash: pkgIdWithPatchHash as PkgIdWithPatchHash,
    id: '' as PkgResolutionId,
    peerDependencies: {},
    children,
    modules: '',
    dir: '',
    depPath: '' as DepPath,
    depth: 0,
    installable: false,
    isPure: false,
    transitivePeerDependencies: new Set<string>(),
    resolvedPeerNames: new Set<string>(resolvedPeerNames),
  } satisfies Node
}

// Regression test for https://github.com/pnpm/pnpm/issues/11834.
//
// Two same-package snapshots can each blame their compat failure on a child
// that points at another duplicate group whose merge is itself blocked by
// this group's merge. The strict-superset pairwise pass bails out. The
// cycle-breaking phase added in `deduplicateAll` tentatively maps every
// duplicate member to the richest member of its group, then drops any
// mapping that doesn't hold under the other tentative mappings.
test('deduplicateAll collapses two mutually-peer-dependent snapshots even when one has an optional peer activated', () => {
  // webpack ↔ terser-webpack-plugin with optional esbuild peer. Two flavors
  // of each: with and without esbuild propagated through the suffix.
  const wPlain = 'webpack@5.107.0' as DepPath
  const wWithE = 'webpack@5.107.0(esbuild@0.27.7)' as DepPath
  const tPlain = 'terser-webpack-plugin@5.6.0(webpack@5.107.0)' as DepPath
  const tWithE = 'terser-webpack-plugin@5.6.0(esbuild@0.27.7)(webpack@5.107.0(esbuild@0.27.7))' as DepPath
  const esbuild = 'esbuild@0.27.7' as DepPath

  const depGraph = {
    [wPlain]: makeNode('webpack', 'webpack/5.107.0', {
      'terser-webpack-plugin': tPlain,
    }),
    [wWithE]: makeNode('webpack', 'webpack/5.107.0', {
      'terser-webpack-plugin': tWithE,
      esbuild,
    }),
    [tPlain]: makeNode('terser-webpack-plugin', 'terser-webpack-plugin/5.6.0', {
      webpack: wPlain,
    }, ['webpack']),
    [tWithE]: makeNode('terser-webpack-plugin', 'terser-webpack-plugin/5.6.0', {
      webpack: wWithE,
      esbuild,
    }, ['webpack', 'esbuild']),
    [esbuild]: makeNode('esbuild', 'esbuild/0.27.7', {}),
  }

  const duplicates: Array<Set<DepPath>> = [
    new Set([wPlain, wWithE]),
    new Set([tPlain, tWithE]),
  ]

  const map = deduplicateAll(depGraph, duplicates)

  expect(map[wPlain]).toBe(wWithE)
  expect(map[tPlain]).toBe(tWithE)
  expect(map[wWithE]).toBeUndefined()
  expect(map[tWithE]).toBeUndefined()
})

test('deduplicateAll cycle phase does not collapse same-pkgId snapshots whose children genuinely differ outside the cycle', () => {
  // Two webpack snapshots in a peer cycle with terser, but webpack-with-e
  // depends on esbuild@0.27 while webpack-plain depends on esbuild@0.20.
  // The plain webpack's esbuild child has no mapping in the tentative map
  // (its pkgIdWithPatchHash is different from the propagated one), so the
  // post-hoc validation rejects the merge.
  const wPlain = 'webpack@5.107.0(esbuild@0.20.0)' as DepPath
  const wWithE = 'webpack@5.107.0(esbuild@0.27.7)' as DepPath
  const tPlain = 'terser-webpack-plugin@5.6.0(esbuild@0.20.0)(webpack@5.107.0(esbuild@0.20.0))' as DepPath
  const tWithE = 'terser-webpack-plugin@5.6.0(esbuild@0.27.7)(webpack@5.107.0(esbuild@0.27.7))' as DepPath
  const esbuild20 = 'esbuild@0.20.0' as DepPath
  const esbuild27 = 'esbuild@0.27.7' as DepPath

  const depGraph = {
    [wPlain]: makeNode('webpack', 'webpack/5.107.0', {
      'terser-webpack-plugin': tPlain,
      esbuild: esbuild20,
    }),
    [wWithE]: makeNode('webpack', 'webpack/5.107.0', {
      'terser-webpack-plugin': tWithE,
      esbuild: esbuild27,
    }),
    [tPlain]: makeNode('terser-webpack-plugin', 'terser-webpack-plugin/5.6.0', {
      webpack: wPlain,
      esbuild: esbuild20,
    }, ['webpack', 'esbuild']),
    [tWithE]: makeNode('terser-webpack-plugin', 'terser-webpack-plugin/5.6.0', {
      webpack: wWithE,
      esbuild: esbuild27,
    }, ['webpack', 'esbuild']),
    [esbuild20]: makeNode('esbuild', 'esbuild/0.20.0', {}),
    [esbuild27]: makeNode('esbuild', 'esbuild/0.27.7', {}),
  }

  const duplicates: Array<Set<DepPath>> = [
    new Set([wPlain, wWithE]),
    new Set([tPlain, tWithE]),
  ]

  const map = deduplicateAll(depGraph, duplicates)

  expect(map[wPlain]).toBeUndefined()
  expect(map[wWithE]).toBeUndefined()
  expect(map[tPlain]).toBeUndefined()
  expect(map[tWithE]).toBeUndefined()
})

test('deduplicateAll standard pass still wins when one duplicate is a strict superset', () => {
  // Regression check: the cycle phase only fires when the standard pass
  // makes zero progress. If one snapshot is a strict superset, the existing
  // pass handles it and the cycle phase is a no-op.
  const wPlain = 'webpack@5.107.0' as DepPath
  const wWithE = 'webpack@5.107.0(esbuild@0.27.7)' as DepPath
  const esbuild = 'esbuild@0.27.7' as DepPath

  const depGraph = {
    [wPlain]: makeNode('webpack', 'webpack/5.107.0', {}),
    [wWithE]: makeNode('webpack', 'webpack/5.107.0', { esbuild }),
    [esbuild]: makeNode('esbuild', 'esbuild/0.27.7', {}),
  }

  const duplicates: Array<Set<DepPath>> = [new Set([wPlain, wWithE])]

  const map = deduplicateAll(depGraph, duplicates)

  expect(map[wPlain]).toBe(wWithE)
})
