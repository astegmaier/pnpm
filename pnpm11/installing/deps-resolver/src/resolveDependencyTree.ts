import { resolveFromCatalog } from '@pnpm/catalogs.resolver'
import type { Catalogs } from '@pnpm/catalogs.types'
import { pickRegistryContext } from '@pnpm/config.normalize-registries'
import { createPackageVersionPolicyOrThrow, getPublishedByPolicy } from '@pnpm/config.version-policy'
import type { LockfileObject } from '@pnpm/lockfile.types'
import { globalWarn } from '@pnpm/logger'
import type { PatchGroupRecord } from '@pnpm/patching.config'
import { BUILTIN_REGISTRIES_BY_PREFIX } from '@pnpm/resolving.npm-resolver'
import type { PreferredVersions, Resolution, ResolutionPolicyViolation, WorkspacePackages } from '@pnpm/resolving.resolver-base'
import type { StoreController } from '@pnpm/store.controller-types'
import { type AllowBuild, type AllowedDeprecatedVersions, DEPENDENCIES_FIELDS, type PkgResolutionId, type ProjectId, type ProjectManifest, type ProjectRootDir, type RangeSpecStyle, type ReadPackageHook, type RegistryContext, type SupportedArchitectures, type TrustPolicy } from '@pnpm/types'
import { partition } from 'ramda'
import semver from 'semver'

import { getNonDevWantedDependencies, type WantedDependency } from './getNonDevWantedDependencies.js'
import { hoistPeers } from './hoistPeers.js'
import type { NodeId } from './nextNodeId.js'
import {
  buildTree,
  type ChildrenByParentId,
  type DependenciesTree,
  type ImporterToResolve,
  type ImporterToResolveOptions,
  type LinkedDependency,
  mergePkgsDeps,
  type MissingPeers,
  type ParentPkgAliases,
  type PendingNode,
  type PkgAddress,
  type PkgAddressOrLink,
  type ResolutionContext,
  resolveDependencies as resolveMoreDependencies,
  type ResolvedPackage,
  type ResolvedPkgsById,
  resolveRootDependencies,
} from './resolveDependencies.js'
import type { MissingRequiredPeersByProject } from './resolvePeers.js'

export type { DependenciesTree, DependenciesTreeNode, LinkedDependency, ResolvedPackage } from './resolveDependencies.js'

export interface ResolvedImporters {
  [id: string]: {
    directDependencies: ResolvedDirectDependency[]
    directNodeIdsByAlias: Map<string, NodeId>
    hoistedPeerProviderNodeIds: Set<NodeId>
    linkedDependencies: LinkedDependency[]
  }
}

export interface ResolvedDirectDependency {
  alias: string
  optional: boolean
  dev: boolean
  resolution: Resolution
  pkgId: PkgResolutionId
  version: string
  name: string
  catalogLookup?: CatalogLookupMetadata
  normalizedBareSpecifier?: string
  /**
   * The wanted dependency this was resolved from, carried so consumers can
   * recover the request directly. See `updateProjectManifest`.
   */
  wantedDependency?: WantedDependency
}

/**
 * Information related to the catalog entry for this dependency if it was
 * requested through the catalog protocol.
 */
export interface CatalogLookupMetadata {
  readonly catalogName: string
  readonly specifier: string

  /**
   * The catalog protocol bareSpecifier the user wrote in package.json files or as a
   * parameter to pnpm add. Ex: pnpm add foo@catalog:
   *
   * This will usually be 'catalog:<name>', but can simply be 'catalog:' if
   * users wrote the default catalog shorthand. This is different than the
   * catalogName field, which would be 'default' regardless of whether users
   * originally requested 'catalog:' or 'catalog:default'.
   */
  readonly userSpecifiedBareSpecifier: string
}

export interface Importer<WantedDepExtraProps> {
  id: ProjectId
  manifest: ProjectManifest
  modulesDir: string
  removePackages?: string[]
  rootDir: ProjectRootDir
  wantedDependencies: Array<WantedDepExtraProps & WantedDependency>
}

export interface ImporterToResolveGeneric<WantedDepExtraProps> extends Importer<WantedDepExtraProps> {
  updatePackageManifest: boolean
  updateMatching?: (pkgName: string, version?: string) => boolean
  updatePatches?: boolean
  updateToLatest?: boolean
  hasRemovedDependencies?: boolean
  preferredVersions?: PreferredVersions
  wantedDependencies: Array<WantedDepExtraProps & WantedDependency & { updateDepth: number }>
  rangeSpecStyle?: RangeSpecStyle
}

export interface ResolveDependenciesOptions extends RegistryContext {
  allowBuild?: AllowBuild
  autoInstallPeers?: boolean
  autoInstallPeersFromHighestMatch?: boolean
  allowedDeprecatedVersions: AllowedDeprecatedVersions
  allowUnusedPatches: boolean
  catalogs?: Catalogs
  currentLockfile: LockfileObject
  dedupePeerDependents?: boolean
  dryRun: boolean
  engineStrict: boolean
  force: boolean
  forceFullResolution: boolean
  updateChecksums?: boolean
  ignoreScripts?: boolean
  hooks: {
    readPackage?: ReadPackageHook
  }
  overrideBareSpecifier?: (name: string, bareSpecifier: string, dir?: string) => string | undefined
  nodeVersion?: string
  patchedDependencies?: PatchGroupRecord
  pnpmVersion: string
  preferredVersions?: PreferredVersions
  preferWorkspacePackages?: boolean
  resolutionMode?: 'highest' | 'time-based' | 'lowest-direct'
  resolvePeersFromWorkspaceRoot?: boolean
  injectWorkspacePackages?: boolean
  linkWorkspacePackagesDepth?: number
  lockfileDir: string
  storeController: StoreController
  tag: string
  virtualStoreDir: string
  globalVirtualStoreDir: string
  virtualStoreDirMaxLength: number
  wantedLockfile: LockfileObject
  workspacePackages: WorkspacePackages
  supportedArchitectures?: SupportedArchitectures
  peersSuffixMaxLength: number
  minimumReleaseAge?: number
  minimumReleaseAgeExclude?: string[]
  trustPolicy?: TrustPolicy
  trustPolicyExclude?: string[]
  trustPolicyIgnoreAfter?: number
  blockExoticSubdeps?: boolean
}

export interface ResolveDependencyTreeResult {
  allPeerDepNames: Set<string>
  dependenciesTree: DependenciesTree<ResolvedPackage>
  outdatedDependencies: {
    [pkgId: string]: string
  }
  resolvedImporters: ResolvedImporters
  resolvedPkgsById: ResolvedPkgsById
  wantedToBeSkippedPackageIds: Set<string>
  time?: Record<string, string>
  /**
   * Policy violations collected inline during resolution — the
   * resolver pushes to this list whenever it picks a package that
   * trips one of its own checks (today: `minimumReleaseAge`). The
   * shape mirrors `ResolutionPolicyViolation`; downstream callers
   * filter by `code` to decide what to do.
   */
  resolutionPolicyViolations: ResolutionPolicyViolation[]
  resolveAdditionalPeers: (missingRequiredPeersByProject: MissingRequiredPeersByProject) => Promise<{
    resolutionPolicyViolations: ResolutionPolicyViolation[]
    updatedImporterIds: ProjectId[]
  }>
}

export async function resolveDependencyTree<T> (
  importers: Array<ImporterToResolveGeneric<T>>,
  opts: ResolveDependenciesOptions
): Promise<ResolveDependencyTreeResult> {
  const wantedToBeSkippedPackageIds = new Set<PkgResolutionId>()
  const autoInstallPeers = opts.autoInstallPeers === true
  const { publishedBy: maximumPublishedBy, publishedByExclude } = getPublishedByPolicy(opts)
  const ctx: ResolutionContext = {
    allowBuild: opts.allowBuild,
    autoInstallPeers,
    autoInstallPeersFromHighestMatch: opts.autoInstallPeersFromHighestMatch === true,
    allowedDeprecatedVersions: opts.allowedDeprecatedVersions,
    catalogResolver: resolveFromCatalog.bind(null, opts.catalogs ?? {}),
    childrenByParentId: {} as ChildrenByParentId,
    currentLockfile: opts.currentLockfile,
    defaultTag: opts.tag,
    dependenciesTree: new Map() as DependenciesTree<ResolvedPackage>,
    dryRun: opts.dryRun,
    engineStrict: opts.engineStrict,
    force: opts.force,
    forceFullResolution: opts.forceFullResolution,
    updateChecksums: opts.updateChecksums,
    ignoreScripts: opts.ignoreScripts,
    injectWorkspacePackages: opts.injectWorkspacePackages,
    linkWorkspacePackagesDepth: opts.linkWorkspacePackagesDepth ?? -1,
    lockfileDir: opts.lockfileDir,
    nodeVersion: opts.nodeVersion,
    outdatedDependencies: {} as { [pkgId: string]: string },
    patchedDependencies: opts.patchedDependencies,
    pendingNodes: [] as PendingNode[],
    pnpmVersion: opts.pnpmVersion,
    preferWorkspacePackages: opts.preferWorkspacePackages,
    readPackageHook: opts.hooks.readPackage,
    overrideBareSpecifier: opts.overrideBareSpecifier,
    ...pickRegistryContext(opts),
    namedRegistryPrefixes: Array.from(
      new Set([
        ...Object.keys(BUILTIN_REGISTRIES_BY_PREFIX),
        ...Object.keys(opts.registriesByPrefix ?? {}),
      ])
    ).map((alias) => `${alias}:`),
    resolvedPkgsById: {} as ResolvedPkgsById,
    resolvePeersFromWorkspaceRoot: opts.resolvePeersFromWorkspaceRoot,
    resolutionMode: opts.resolutionMode,
    skipped: wantedToBeSkippedPackageIds,
    storeController: opts.storeController,
    virtualStoreDir: opts.virtualStoreDir,
    virtualStoreDirMaxLength: opts.virtualStoreDirMaxLength,
    wantedLockfile: opts.wantedLockfile,
    updatedSet: new Set<string>(),
    workspacePackages: opts.workspacePackages,
    missingPeersOfChildrenByPkgId: {},
    hoistPeers: autoInstallPeers || opts.dedupePeerDependents,
    allPeerDepNames: new Set(),
    maximumPublishedBy,
    publishedByExclude,
    packageResolutionBarrier: {
      activeByDepth: new Map(),
      waiters: [],
    },
    childrenResolutionByPkgId: {},
    childrenResolutionId: 0,
    importerResolutionOrder: Object.fromEntries(importers.map(({ id }, index) => [id, index])),
    nodeResolutionContextByNodeId: new Map(),
    trustPolicy: opts.trustPolicy,
    trustPolicyExclude: opts.trustPolicyExclude ? createPackageVersionPolicyOrThrow(opts.trustPolicyExclude, 'trustPolicyExclude') : undefined,
    trustPolicyIgnoreAfter: opts.trustPolicyIgnoreAfter,
    blockExoticSubdeps: opts.blockExoticSubdeps,
    resolutionPolicyViolations: [],
  }

  const resolveArgs: ImporterToResolve[] = importers.map((importer) => {
    const projectSnapshot = opts.wantedLockfile.importers[importer.id]
    // This may be optimized.
    // We only need to proceed resolving every dependency
    // if the newly added dependency has peer dependencies.
    const proceed = importer.id === '.' || importer.hasRemovedDependencies === true || importer.wantedDependencies.some((wantedDep: any) => wantedDep.isNew) // eslint-disable-line @typescript-eslint/no-explicit-any
    const resolveOpts: ImporterToResolveOptions = {
      currentDepth: 0,
      parentPkg: {
        installable: true,
        nodeId: importer.id as unknown as NodeId,
        optional: false,
        pkgId: importer.id as unknown as PkgResolutionId,
        rootDir: importer.rootDir,
      },
      parentIds: [importer.id as unknown as PkgResolutionId],
      proceed,
      resolvedDependencies: {
        ...projectSnapshot.dependencies,
        ...projectSnapshot.devDependencies,
        ...projectSnapshot.optionalDependencies,
      },
      updateDepth: -1,
      updateMatching: importer.updateMatching,
      updatePatches: importer.updatePatches,
      updateToLatest: importer.updateToLatest,
      prefix: importer.rootDir,
      supportedArchitectures: opts.supportedArchitectures,
    }
    return {
      updatePackageManifest: importer.updatePackageManifest,
      parentPkgAliases: Object.fromEntries(
        importer.wantedDependencies.filter(({ alias }) => alias).map(({ alias }) => [alias, true])
      ) as ParentPkgAliases,
      preferredVersions: importer.preferredVersions ?? {},
      wantedDependencies: importer.wantedDependencies,
      options: resolveOpts,
      rangeSpecStyle: importer.rangeSpecStyle,
    }
  })
  const {
    pkgAddressesByImporters,
    publishedBy: resolvedPublishedBy,
    time,
    workspaceRootDeps,
  } = await resolveRootDependencies(ctx, resolveArgs)
  const directDepsByImporterId: Record<string, PkgAddressOrLink[]> = Object.fromEntries(
    importers.map(({ id }, index) => [id, pkgAddressesByImporters[index]])
  )

  for (const directDependencies of pkgAddressesByImporters) {
    for (const directDep of directDependencies as PkgAddress[]) {
      const { alias, normalizedBareSpecifier, version, saveCatalogName } = directDep

      if (saveCatalogName == null) {
        continue
      }

      const existingCatalog = opts.catalogs?.default?.[alias]
      if (existingCatalog != null) {
        if (existingCatalog !== normalizedBareSpecifier) {
          globalWarn(
            `Skip adding ${alias} to the default catalog because it already exists as ${existingCatalog}. Please use \`pnpm update\` to update the catalogs.`
          )
        }
      } else if (normalizedBareSpecifier != null && version != null) {
        const userSpecifiedBareSpecifier = `catalog:${saveCatalogName === 'default' ? '' : saveCatalogName}`

        // Attach metadata about how this new catalog dependency should be
        // resolved so the pnpm-lock.yaml file's catalogs section can be updated
        // to reflect this newly added entry.
        directDep.catalogLookup = {
          catalogName: saveCatalogName,
          specifier: normalizedBareSpecifier,
          userSpecifiedBareSpecifier,
        }
      }
    }
  }

  let processedPendingNodes = 0
  const resolvedImporters: ResolvedImporters = {}
  const attemptedPeerAliasesByImporter = new Map<string, Set<string>>()
  const declaredDirectAliasesByImporter = new Map(importers.map((importer) => [
    importer.id,
    new Set([
      ...DEPENDENCIES_FIELDS.flatMap((dependenciesField) =>
        Object.keys(importer.manifest[dependenciesField] ?? {})
      ),
      ...importer.wantedDependencies.flatMap(({ alias }) => alias == null ? [] : [alias]),
    ]),
  ]))
  const workspaceRootImporterId = ctx.resolvePeersFromWorkspaceRoot
    ? importers.find(({ id }) => id === '.')?.id
    : undefined

  materializePendingNodes()
  for (const importer of importers) {
    updateResolvedImporter(importer)
  }

  async function resolveAdditionalPeers (
    missingRequiredPeersByProject: MissingRequiredPeersByProject
  ): Promise<{
    resolutionPolicyViolations: ResolutionPolicyViolation[]
    updatedImporterIds: ProjectId[]
  }> {
    if (!ctx.autoInstallPeers) {
      return {
        resolutionPolicyViolations: [],
        updatedImporterIds: [],
      }
    }
    const violationCount = ctx.resolutionPolicyViolations.length
    const additionalResolutions = await Promise.all(importers.map(async (importer, index) => {
      const dependencies = getAdditionalPeerDependencies(
        importer.id,
        importer.rootDir,
        missingRequiredPeersByProject[importer.id]
      )
      if (Object.keys(dependencies).length === 0) return undefined

      const parentPkgAliases = getCurrentParentPkgAliases(importer.id, index)
      for (const peerName of Object.keys(dependencies)) {
        parentPkgAliases[peerName] = true
      }
      const resolution = await resolveMoreDependencies(
        ctx,
        resolveArgs[index].preferredVersions,
        getNonDevWantedDependencies({ dependencies }),
        {
          ...resolveArgs[index].options,
          parentPkgAliases,
          publishedBy: resolvedPublishedBy,
          updateToLatest: false,
        }
      )
      return {
        importerId: importer.id,
        parentPkgAliases,
        peerResolution: await resolution.resolvingPeers,
        pkgAddresses: resolution.pkgAddresses,
      }
    }))

    const updatedImporterIds: ProjectId[] = []
    for (const additionalResolution of additionalResolutions) {
      if (additionalResolution == null) continue
      if (appendAdditionalPeerAddresses(additionalResolution)) {
        updatedImporterIds.push(additionalResolution.importerId)
      }
    }
    if (updatedImporterIds.length > 0) {
      materializePendingNodes()
      for (const importer of importers) {
        if (updatedImporterIds.includes(importer.id)) {
          updateResolvedImporter(importer)
        }
      }
    }
    return {
      resolutionPolicyViolations: ctx.resolutionPolicyViolations.slice(violationCount),
      updatedImporterIds,
    }
  }

  function getAdditionalPeerDependencies (
    importerId: ProjectId,
    importerRootDir: ProjectRootDir,
    missingRequiredPeers: MissingRequiredPeersByProject[string] | undefined
  ): Record<string, string> {
    if (missingRequiredPeers == null) return {}
    const peerRequirements: MissingPeers[] = []
    const attemptedPeerAliases = getAttemptedPeerAliases(importerId)
    for (const [peerName, ranges] of missingRequiredPeers) {
      if (
        attemptedPeerAliases.has(peerName) ||
        hasExistingPeerProvider(importerId, peerName)
      ) continue
      // Protocol and catalog targets stay unresolved here rather than gaining
      // selection semantics that differ from the initial peer-hoist pass.
      if ([...ranges].some((range) => semver.validRange(range, { includePrerelease: true }) == null)) continue
      for (const range of [...ranges].sort()) {
        peerRequirements.push({
          [peerName]: {
            optional: false,
            range,
          },
        })
      }
    }
    const mergedPeers = mergePkgsDeps(peerRequirements, {
      autoInstallPeersFromHighestMatch: ctx.autoInstallPeersFromHighestMatch,
    })
    const dependencies = hoistPeers({
      autoInstallPeers: true,
      allPreferredVersions: ctx.allPreferredVersions,
      workspaceRootDeps,
      overrideBareSpecifier: ctx.overrideBareSpecifier == null
        ? undefined
        : (name, range) => ctx.overrideBareSpecifier!(name, range, importerRootDir),
    }, Object.entries(mergedPeers))
    const unattemptedDependencies: Record<string, string> = {}
    for (const peerName of Object.keys(dependencies).sort()) {
      if (attemptedPeerAliases.has(peerName) || hasExistingPeerProvider(importerId, peerName)) continue
      attemptedPeerAliases.add(peerName)
      unattemptedDependencies[peerName] = dependencies[peerName]
    }
    return unattemptedDependencies
  }

  function getAttemptedPeerAliases (importerId: ProjectId): Set<string> {
    let attemptedPeerAliases = attemptedPeerAliasesByImporter.get(importerId)
    if (attemptedPeerAliases == null) {
      attemptedPeerAliases = new Set()
      attemptedPeerAliasesByImporter.set(importerId, attemptedPeerAliases)
    }
    return attemptedPeerAliases
  }

  function hasExistingPeerProvider (importerId: ProjectId, peerName: string): boolean {
    if (declaredDirectAliasesByImporter.get(importerId)?.has(peerName) === true) return true
    if (directDepsByImporterId[importerId].some((dependency) =>
      dependency.alias === peerName || dependency.pkg.name === peerName
    )) return true
    return workspaceRootImporterId != null &&
      workspaceRootImporterId !== importerId &&
      directDepsByImporterId[workspaceRootImporterId].some((dependency) =>
        dependency.alias === peerName || dependency.pkg.name === peerName
      )
  }

  function getCurrentParentPkgAliases (importerId: ProjectId, index: number): ParentPkgAliases {
    const parentPkgAliases = { ...resolveArgs[index].parentPkgAliases }
    for (const directDependency of directDepsByImporterId[importerId]) {
      parentPkgAliases[directDependency.alias] = directDependency.isLinkedDependency === true
        ? true
        : directDependency
    }
    return parentPkgAliases
  }

  function appendAdditionalPeerAddresses (
    {
      importerId,
      parentPkgAliases,
      peerResolution,
      pkgAddresses,
    }: {
      importerId: ProjectId
      parentPkgAliases: ParentPkgAliases
      peerResolution: { resolvedPeers: Record<string, PkgAddress> }
      pkgAddresses: PkgAddressOrLink[]
    }
  ): boolean {
    const directDependencies = directDepsByImporterId[importerId]
    const directAliases = new Set(directDependencies.map(({ alias }) => alias))
    let changed = false
    for (const pkgAddress of pkgAddresses) {
      if (directAliases.has(pkgAddress.alias)) continue
      directDependencies.push(pkgAddress)
      directAliases.add(pkgAddress.alias)
      changed = true
    }
    for (const [peerName, resolvedPeerAddress] of Object.entries(peerResolution.resolvedPeers)) {
      if (
        parentPkgAliases[peerName] ||
        directAliases.has(resolvedPeerAddress.alias) ||
        hasExistingPeerProvider(importerId, peerName)
      ) continue
      directDependencies.push({
        ...resolvedPeerAddress,
        hoistedPeerProvider: true,
      })
      directAliases.add(resolvedPeerAddress.alias)
      changed = true
    }
    return changed
  }

  function materializePendingNodes (): void {
    for (; processedPendingNodes < ctx.pendingNodes.length; processedPendingNodes++) {
      const pendingNode = ctx.pendingNodes[processedPendingNodes]
      ctx.dependenciesTree.set(pendingNode.nodeId, {
        children: () => buildTree(ctx, pendingNode.resolvedPackage.id,
          pendingNode.parentIds,
          ctx.childrenByParentId[pendingNode.resolvedPackage.id], pendingNode.depth + 1, pendingNode.installable),
        depth: pendingNode.depth,
        installable: pendingNode.installable,
        lockedPeerContext: pendingNode.lockedPeerContext,
        previousDepPath: pendingNode.previousDepPath,
        resolvedPackage: pendingNode.resolvedPackage,
      })
    }
  }

  function updateResolvedImporter ({ id, wantedDependencies }: ImporterToResolveGeneric<T>): void {
    const directDeps = dedupeSameAliasDirectDeps(directDepsByImporterId[id], wantedDependencies)
    const [linkedDependencies, directNonLinkedDeps] = partition((dep) => dep.isLinkedDependency === true, directDeps) as [LinkedDependency[], PkgAddress[]]
    resolvedImporters[id] = {
      directDependencies: directDeps
        .map((dep) => {
          if (dep.isLinkedDependency === true) {
            return dep
          }
          const resolvedPackage = ctx.dependenciesTree.get(dep.nodeId)!.resolvedPackage as ResolvedPackage
          return {
            alias: dep.alias,
            catalogLookup: dep.catalogLookup,
            dev: resolvedPackage.dev,
            name: resolvedPackage.name,
            optional: resolvedPackage.optional,
            pkgId: resolvedPackage.id,
            resolution: resolvedPackage.resolution,
            version: resolvedPackage.version,
            normalizedBareSpecifier: dep.normalizedBareSpecifier,
            wantedDependency: dep.wantedDependency,
          }
        }),
      directNodeIdsByAlias: new Map(directNonLinkedDeps.map(({ alias, nodeId }) => [alias, nodeId])),
      hoistedPeerProviderNodeIds: new Set(directNonLinkedDeps.filter((dep) => dep.hoistedPeerProvider).map(({ nodeId }) => nodeId)),
      linkedDependencies,
    }
  }

  return {
    dependenciesTree: ctx.dependenciesTree,
    outdatedDependencies: ctx.outdatedDependencies,
    resolvedImporters,
    resolvedPkgsById: ctx.resolvedPkgsById,
    wantedToBeSkippedPackageIds,
    time,
    allPeerDepNames: ctx.allPeerDepNames,
    resolutionPolicyViolations: ctx.resolutionPolicyViolations,
    resolveAdditionalPeers,
  }
}

/**
  * There may be cases where multiple dependencies have the same alias in the directDeps array.
  * E.g., when there is "is-negative: github:kevva/is-negative#1.0.0" in the package.json dependencies,
  * and then re-execute `pnpm add github:kevva/is-negative#1.0.1`.
  * In order to make sure that the latest 1.0.1 version is installed, we need to remove the duplicate dependency.
  * fix https://github.com/pnpm/pnpm/issues/6966
  */
function dedupeSameAliasDirectDeps (directDeps: PkgAddressOrLink[], wantedDependencies: Array<WantedDependency & { isNew?: boolean }>): PkgAddressOrLink[] {
  const deps = new Map<string, PkgAddressOrLink>()
  for (const directDep of directDeps) {
    const { alias, normalizedBareSpecifier } = directDep
    if (!deps.has(alias)) {
      deps.set(alias, directDep)
    } else {
      const wantedDep = wantedDependencies.find(dep =>
        dep.alias ? dep.alias === alias : dep.bareSpecifier === normalizedBareSpecifier
      )
      if (wantedDep?.isNew) {
        deps.set(alias, directDep)
      }
    }
  }
  return Array.from(deps.values())
}
