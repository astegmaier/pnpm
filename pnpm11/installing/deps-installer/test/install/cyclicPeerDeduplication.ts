import path from 'node:path'

import { afterEach, expect, test } from '@jest/globals'
import { type MutatedProject, mutateModules, type MutateModulesOptions, type ProjectOptions } from '@pnpm/installing.deps-installer'
import { preparePackages } from '@pnpm/prepare'
import type { PackageMeta } from '@pnpm/resolving.registry.types'
import { getMockAgent, setupMockAgent, teardownMockAgent } from '@pnpm/testing.mock-agent'
import type { ProjectManifest, ProjectRootDir } from '@pnpm/types'

import { testDefaults } from '../utils/index.js'

afterEach(async () => {
  await teardownMockAgent()
})

// Regression test for https://github.com/pnpm/pnpm/issues/11834.
//
// Reproduces the webpack ↔ terser-webpack-plugin situation: two packages
// have a peer-dependency cycle (webpack depends on terser-webpack-plugin,
// terser-webpack-plugin peer-depends on webpack), and one of them
// (terser-webpack-plugin) has an optional peer (esbuild). When some
// workspace projects activate the optional peer and others don't, pnpm
// produces two snapshots of each cycle member. Before the fix,
// `dedupePeerDependents` failed to collapse them because the strict
// superset check ran against children that were themselves not yet
// deduplicated, and both pairs failed the check simultaneously.
test('dedupePeerDependents collapses cyclic peer snapshots when an optional transitive peer is activated by only some importers', async () => {
  await setupMockAgent()

  const aName = '@pnpm.e2e/cycle-peer-a'
  const bName = '@pnpm.e2e/cycle-peer-b'
  const cName = '@pnpm.e2e/cycle-peer-c'

  // project1 has just A + B; project2 also has C, which is the optional
  // peer of B. Before the fix this produces two snapshots each of A and B
  // because A also gets the (C) suffix propagated through its child B.
  preparePackages([
    {
      location: 'project1',
      package: {
        name: 'project1',
        dependencies: { [aName]: '1.0.0', [bName]: '1.0.0' },
      },
    },
    {
      location: 'project2',
      package: {
        name: 'project2',
        dependencies: { [aName]: '1.0.0', [bName]: '1.0.0', [cName]: '1.0.0' },
      },
    },
  ])

  const project1Dir = path.resolve('project1') as ProjectRootDir
  const project2Dir = path.resolve('project2') as ProjectRootDir
  const lockfileDir = process.cwd() as ProjectRootDir

  const project1Manifest: ProjectManifest = {
    name: 'project1',
    dependencies: { [aName]: '1.0.0', [bName]: '1.0.0' },
  }
  const project2Manifest: ProjectManifest = {
    name: 'project2',
    dependencies: { [aName]: '1.0.0', [bName]: '1.0.0', [cName]: '1.0.0' },
  }

  const allProjects: ProjectOptions[] = [
    { buildIndex: 0, manifest: project1Manifest, rootDir: project1Dir },
    { buildIndex: 0, manifest: project2Manifest, rootDir: project2Dir },
  ]

  const options = {
    ...testDefaults(
      { allProjects, autoInstallPeers: false, dedupePeerDependents: true, forceFullResolution: true },
      { retry: { retries: 0 } }
    ),
    lockfileDir,
    lockfileOnly: true,
  } satisfies MutateModulesOptions

  const importers: MutatedProject[] = [
    { mutation: 'install', rootDir: project1Dir },
    { mutation: 'install', rootDir: project2Dir },
  ]

  const registryUrl = options.registries.default.replace(/\/$/, '')

  function makeMeta (name: string, deps: Record<string, string>, peerDeps: Record<string, string>, peerDepsMeta: Record<string, { optional?: boolean }> = {}): PackageMeta {
    return {
      name,
      versions: {
        '1.0.0': {
          name,
          version: '1.0.0',
          dependencies: deps,
          peerDependencies: peerDeps,
          peerDependenciesMeta: peerDepsMeta,
          dist: {
            // Resolver only reads metadata when lockfileOnly is true, so
            // the shasum value is never checked against a tarball.
            shasum: '0000000000000000000000000000000000000000',
            tarball: `${options.registries.default}/${encodeURIComponent(name)}-1.0.0.tgz`,
          },
        },
      },
      'dist-tags': { latest: '1.0.0' },
    }
  }

  // A → B (dep), B → A (peer required), B → C (peer optional).
  // This mirrors webpack (A) → terser-webpack-plugin (B) → esbuild (C).
  const metaByName: Record<string, PackageMeta> = {
    [aName]: makeMeta(aName, { [bName]: '1.0.0' }, {}),
    [bName]: makeMeta(bName, {}, { [aName]: '1.0.0', [cName]: '1.0.0' }, { [cName]: { optional: true } }),
    [cName]: makeMeta(cName, {}, {}),
  }

  function metadataPath (name: string): string {
    return `/${name.replaceAll('/', '%2F')}`
  }

  const agent = getMockAgent().get(registryUrl)
  for (const [name, meta] of Object.entries(metaByName)) {
    agent.intercept({ path: metadataPath(name), method: 'GET' }).reply(200, meta).persist()
  }

  await mutateModules(importers, options)

  const { readYamlFileSync } = await import('read-yaml-file')
  const lockfile = readYamlFileSync<{ snapshots?: Record<string, unknown> }>(path.resolve('pnpm-lock.yaml'))
  const snapshotKeys = Object.keys(lockfile.snapshots ?? {})

  // Only one snapshot of A and one of B should remain after dedup. (C has
  // no peer suffix because it has no peers of its own.)
  const aSnapshots = snapshotKeys.filter((k) => k.startsWith(`${aName}@`))
  const bSnapshots = snapshotKeys.filter((k) => k.startsWith(`${bName}@`))
  expect(aSnapshots).toHaveLength(1)
  expect(bSnapshots).toHaveLength(1)
  // The surviving snapshots are the ones with the C suffix (the "richer"
  // members of each duplicate group).
  expect(aSnapshots[0]).toContain(`(${cName}@1.0.0)`)
  expect(bSnapshots[0]).toContain(`(${cName}@1.0.0)`)
})
