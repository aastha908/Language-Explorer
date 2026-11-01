import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import type { Map as MapLibreMap, VectorSourceSpecification } from 'maplibre-gl'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Layer, Source, useMap } from 'react-map-gl/maplibre'
import { languageArchiveUrl } from '../../../data/atlasRepository'
import type { GeometryVariant } from '../../../domain/atlas'
import {
  atlasDataAtom,
  geographyDatasetFilterAtom,
  languageOpacityAtom,
  overlapModeAtom,
  temporalViewAtom,
  visibleLanguageIdsAtom,
} from '../../../state/atlasState'
import { COVERAGE_LAYER, type DeliveryTile, tileKey } from './delivery'
import { type CoverageSnapshot, registerCoverage, releaseCoverage } from './deliveryProtocol'
import { diagnosticsEnabled, overlapDiagnostics } from './diagnostics'
import { fallbackTilesUrl } from './fallbackProtocol'
import {
  checkPatternBudget,
  MAX_PATTERN_PIXELS,
  OverlapPatternError,
  patternPixels,
  stripeImage,
} from './patterns'
import { installOverlapTestApi } from './testBridge'
import { coverageTilesKey, retainCoverageTiles, tilesForBounds } from './tiles'
import type { OverlapProperties, OverlapRequest, OverlapResponse, TileCoordinate } from './types'
import { OverlapWorkerClient, PUBLICATION_TIMEOUT_MS } from './workerClient'

const OVERLAP_SOURCE = 'language-overlap-regions'
const OVERLAP_LAYER = 'language-overlap-hatching'
const FALLBACK_SOURCE = 'language-overlap-fallback'
const BUFFERS = [0, 1] as const
const INSPECTION_LAYER = 'inspected-language-areas'
const EXAMPLE_LANGUAGE_IDS = ['stan1293', 'wels1247', 'scot1245', 'iris1253']

interface HatchingState {
  readonly snapshots: readonly [CoverageSnapshot | null, CoverageSnapshot | null]
  readonly activeBuffer: number | null
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly message: string
}

const installPatterns = (
  map: MapLibreMap,
  properties: readonly OverlapProperties[],
  colors: ReadonlyMap<string, string>,
  ownedPatterns: Set<string>,
) => {
  if (!map.isStyleLoaded()) throw new Error('Map style is not ready to draw overlap stripes.')
  const uniquePatterns = new Map(properties.map((properties) => [properties.pattern, properties]))
  const pixels = [...uniquePatterns.values()].reduce(
    (sum, { variantIds }) => sum + patternPixels(variantIds.length),
    0,
  )
  checkPatternBudget(pixels)
  let residentPixels = 0
  for (const id of ownedPatterns) {
    const image = map.getImage(id)?.data
    if (image) residentPixels += (image.width + 2) * (image.height + 2)
  }
  for (const properties of uniquePatterns.values())
    if (!map.hasImage(properties.pattern))
      residentPixels += patternPixels(properties.variantIds.length)
  // Both old and new buffers may be live during publication.
  checkPatternBudget(residentPixels, 2 * MAX_PATTERN_PIXELS)
  const patterns = new Set<string>()
  for (const properties of uniquePatterns.values()) {
    patterns.add(properties.pattern)
    if (map.hasImage(properties.pattern)) continue
    const memberColors = properties.variantIds.map((id) => {
      const color = colors.get(id)
      if (!color) throw new Error(`Missing language color for ${id}`)
      return color
    })
    map.addImage(properties.pattern, stripeImage(memberColors), { pixelRatio: 1 })
    ownedPatterns.add(properties.pattern)
  }
  return { patterns, pixels }
}

export const OverlapHatching = ({
  variants,
  selectionKey,
  coverageReady,
  onCoverageReady,
  targetLayerId = 'selected-language-areas',
  inspectionLayerId = INSPECTION_LAYER,
  beforeId,
  showControls = true,
  onStatus,
}: {
  readonly variants: readonly GeometryVariant[]
  readonly selectionKey: string
  readonly coverageReady: boolean
  readonly onCoverageReady: (key: string | null) => void
  readonly targetLayerId?: string
  readonly inspectionLayerId?: string
  readonly beforeId?: string
  readonly showControls?: boolean
  readonly onStatus?: (status: HatchingState['status'], message: string) => void
}) => {
  const { current } = useMap()
  const map = current?.getMap()
  const data = useAtomValue(atlasDataAtom)
  const [mode, setMode] = useAtom(overlapModeAtom)
  const [opacity, setOpacity] = useAtom(languageOpacityAtom)
  const setVisibleIds = useSetAtom(visibleLanguageIdsAtom)
  const setPeriod = useSetAtom(temporalViewAtom)
  const setDatasetFilter = useSetAtom(geographyDatasetFilterAtom)
  const [state, setState] = useState<HatchingState>({
    snapshots: [null, null],
    activeBuffer: null,
    status: 'idle',
    message: '',
  })
  const configRef = useRef({ selectionKey, mode })
  const refreshRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    onStatus?.(state.status, state.message)
  }, [onStatus, state.message, state.status])

  useEffect(() => {
    if (!diagnosticsEnabled || !map) return
    return installOverlapTestApi(
      map,
      (options) => {
        setPeriod('contemporary')
        setDatasetFilter(['asher2007world'])
        setMode('hatching')
        setVisibleIds(
          options.languageIds === 'all'
            ? [
                ...new Set(
                  data.variants
                    .filter((v) => v.datasetId === 'asher2007world')
                    .map((v) => v.languageId),
                ),
              ]
            : options.languageIds,
        )
        map.jumpTo({ center: options.center, zoom: options.zoom })
      },
      () => refreshRef.current?.(),
      () => configRef.current.selectionKey,
    )
  }, [map, data, setPeriod, setDatasetFilter, setMode, setVisibleIds])

  useEffect(() => {
    if (!map) return
    const syncLayerOrder = () => {
      // The two sources mount independently. Insert normally, then order the
      // layers once both exist, without passing a missing target to addLayer.
      const layers = map.getLayersOrder()
      for (const buffer of BUFFERS) {
        for (const id of [`${OVERLAP_LAYER}-${buffer}`, `${FALLBACK_SOURCE}-${buffer}`]) {
          const overlapIndex = layers.indexOf(id)
          const inspectionIndex = layers.indexOf(inspectionLayerId)
          if (overlapIndex >= 0 && inspectionIndex >= 0 && overlapIndex > inspectionIndex) {
            map.moveLayer(id, inspectionLayerId)
          }
        }
      }
    }
    map.on('styledata', syncLayerOrder)
    syncLayerOrder()
    return () => {
      map.off('styledata', syncLayerOrder)
    }
  }, [map, inspectionLayerId])

  useEffect(() => {
    if (!map) return
    const worker = new OverlapWorkerClient(
      () => new Worker(new URL('./overlap.worker.ts', import.meta.url), { type: 'module' }),
    )
    const colors = new Map(data.variants.map(({ id, color }) => [id, color]))
    let requestId = 0
    let previousKey = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let publicationTimer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let activePatterns = new Set<string>()
    const ownedPatterns = new Set<string>()
    let requestHasTiles = false
    let retainedTiles: TileCoordinate[] = []
    let activeBuffer: number | null = null
    let activeSnapshot: CoverageSnapshot | null = null
    const snapshots = new Map<number, CoverageSnapshot>()
    const results = new Map<string, DeliveryTile>()
    let version = 0
    let publishedVersion = 0
    let complete = false
    let failure = ''
    let requestStartedAt = 0
    let pendingResult: {
      readonly requestId: number
      readonly selectionKey: string
      readonly snapshot: CoverageSnapshot
      readonly patterns: Set<string>
      readonly version: number
      readonly buffer: 0 | 1
      readonly stagedAt: number
    } | null = null

    const report = () =>
      overlapDiagnostics.reports.findLast((entry) => entry.requestId === requestId)
    const readyMessage = () =>
      [...results.values()].some((tile) => tile.patterns.some((p) => p.variantIds.length > 1))
        ? 'Shared areas alternate language colors'
        : 'No overlaps in this view'
    const releaseUnused = (keep: readonly number[]) => {
      for (const [id, snapshot] of snapshots) {
        if (keep.includes(id)) continue
        releaseCoverage(snapshot)
        snapshots.delete(id)
      }
    }

    const stageCoverage = () => {
      clearTimeout(publicationTimer)
      publicationTimer = undefined
      if (pendingResult || version === publishedVersion || !results.size) return
      if (!complete && [...results.values()].every((tile) => tile.features === 0)) return
      const properties = [...results.values()].flatMap((tile) => tile.patterns)
      const patternsStart = performance.now()
      try {
        const { patterns, pixels } = installPatterns(map, properties, colors, ownedPatterns)
        const currentReport = report()
        overlapDiagnostics.update(requestId, {
          patternsMs: (currentReport?.patternsMs ?? 0) + performance.now() - patternsStart,
          patternPixels: pixels,
          features: [...results.values()].reduce((sum, tile) => sum + tile.features, 0),
          sharedPatterns: new Set(
            properties.filter((p) => p.variantIds.length > 1).map((p) => p.pattern),
          ).size,
        })
        activePatterns = new Set([...activePatterns, ...patterns])
        const snapshot = registerCoverage(results)
        snapshots.set(snapshot.id, snapshot)
        const buffer = activeBuffer === 0 ? 1 : 0
        pendingResult = {
          requestId,
          selectionKey: configRef.current.selectionKey,
          snapshot,
          patterns,
          version,
          buffer,
          stagedAt: performance.now(),
        }
        setState((previous) => ({
          ...previous,
          snapshots:
            buffer === 0 ? [snapshot, previous.snapshots[1]] : [previous.snapshots[0], snapshot],
          status: failure ? 'error' : 'loading',
          message: failure || 'Updating overlap stripes…',
        }))
      } catch (error) {
        clearTimeout(deadline)
        worker.cancel()
        failure = error instanceof Error ? error.message : 'Could not draw overlap stripes.'
        overlapDiagnostics.update(requestId, {
          outcome: 'error',
          failure: error instanceof OverlapPatternError ? error.reason : 'render-error',
        })
        setState((previous) => ({ ...previous, status: 'error', message: failure }))
      }
    }

    const publishCoverage = () => {
      const result = pendingResult
      if (!result || result.requestId !== requestId) return
      const sourceId = `${OVERLAP_SOURCE}-${result.buffer}`
      const source = map.getSource(sourceId)?.serialize() as VectorSourceSpecification | undefined
      const fallbackId = `${FALLBACK_SOURCE}-${result.buffer}`
      const fallback = map.getSource(fallbackId)?.serialize() as
        | VectorSourceSpecification
        | undefined
      const coverageLoaded =
        source?.tiles?.[0] === result.snapshot.url && map.isSourceLoaded(sourceId)
      const fallbackLoaded =
        fallback?.tiles?.[0] ===
          fallbackTilesUrl(languageArchiveUrl(), result.snapshot.coverageTiles) &&
        map.isSourceLoaded(fallbackId)
      const currentReport = report()
      const elapsed = performance.now() - result.stagedAt
      if (coverageLoaded && currentReport?.coverageSourceMs === undefined)
        overlapDiagnostics.update(requestId, { coverageSourceMs: elapsed })
      if (fallbackLoaded && currentReport?.fallbackSourceMs === undefined)
        overlapDiagnostics.update(requestId, { fallbackSourceMs: elapsed })
      if (!coverageLoaded || !fallbackLoaded) return
      activeBuffer = result.buffer
      activeSnapshot = result.snapshot
      publishedVersion = result.version
      activePatterns = result.patterns
      pendingResult = null
      const finished = complete && publishedVersion === version
      if (finished) clearTimeout(deadline)
      overlapDiagnostics.update(requestId, {
        ...(failure ? {} : { outcome: finished ? 'ready' : 'pending' }),
        firstCoverageMs:
          currentReport?.firstCoverageMs ??
          (currentReport ? performance.now() - currentReport.startedAt : 0),
        publications: (currentReport?.publications ?? 0) + 1,
        sourceReadyMs: (currentReport?.sourceReadyMs ?? 0) + elapsed,
        ...(finished && currentReport
          ? { totalMs: performance.now() - currentReport.startedAt }
          : {}),
        buffer: result.buffer,
      })
      setState({
        activeBuffer: result.buffer,
        status: failure ? 'error' : finished ? 'ready' : 'loading',
        snapshots: result.buffer === 0 ? [result.snapshot, null] : [null, result.snapshot],
        message: failure || (finished ? readyMessage() : 'Updating overlap stripes…'),
      })
      onCoverageReady(result.selectionKey)
      // The old source becomes inactive in this React commit. Its immutable
      // protocol snapshot can be released; in-flight requests return empty.
      releaseUnused([result.snapshot.id])
      // Coalesce tiles arriving during source preparation into one next batch.
      // This avoids restarting staging for each completed computation tile.
      if (version !== publishedVersion) publicationTimer = setTimeout(stageCoverage, 32)
    }

    const suspendCoverage = () => {
      worker.cancel()
      clearTimeout(deadline)
      if (report()?.outcome === 'pending')
        overlapDiagnostics.update(requestId, { outcome: 'superseded' })
      requestId++
      clearTimeout(publicationTimer)
      publicationTimer = undefined
      previousKey = ''
      pendingResult = null
      retainedTiles = []
      activeBuffer = null
      activeSnapshot = null
      activePatterns.clear()
      results.clear()
      version = publishedVersion = 0
      complete = false
      failure = ''
      releaseUnused([])
      onCoverageReady(null)
    }

    const refresh = () => {
      if (!map.getLayer(targetLayerId)) return
      const config = configRef.current
      const variantIds: string[] = config.mode === 'hatching' ? JSON.parse(config.selectionKey) : []
      const bounds = map.getBounds()
      const viewportTiles =
        variantIds.length > 1
          ? tilesForBounds(
              {
                west: bounds.getWest(),
                east: bounds.getEast(),
                south: bounds.getSouth(),
                north: bounds.getNorth(),
              },
              map.getZoom(),
            )
          : []
      const tiles = retainCoverageTiles(viewportTiles, retainedTiles)
      const key = JSON.stringify([variantIds, coverageTilesKey(tiles)])
      retainedTiles = tiles
      if (key === previousKey) return
      if (report()?.outcome === 'pending')
        overlapDiagnostics.update(requestId, { outcome: 'superseded' })
      previousKey = key
      clearTimeout(deadline)
      clearTimeout(publicationTimer)
      publicationTimer = undefined
      pendingResult = null
      releaseUnused(activeSnapshot ? [activeSnapshot.id] : [])
      // Retain immutable native tiles only at the requested detail level. Old
      // rendered coverage remains in its snapshot until a replacement is ready.
      const desired = new Set(tiles.map(tileKey))
      for (const key of results.keys()) if (!desired.has(key)) results.delete(key)
      version++
      complete = false
      failure = ''
      requestHasTiles = tiles.length > 0
      const request: OverlapRequest = {
        ...(diagnosticsEnabled ? { profile: true } : {}),
        requestId: ++requestId,
        archiveUrl: languageArchiveUrl().replace(/^pmtiles:\/\//, ''),
        sourceLayer: data.manifest.vectorLayer,
        variantIds,
        tiles,
        knownTiles: [...results.keys()],
      }
      requestStartedAt = performance.now()
      if (tiles.length > 0)
        overlapDiagnostics.start(request.requestId, tiles.length, variantIds.length)
      worker.postMessage(request)
      if (tiles.length > 0)
        deadline = setTimeout(() => {
          worker.cancel()
          requestHasTiles = false
          complete = true
          failure =
            'Overlap display exceeded its time budget. Keeping available coverage; try another view.'
          overlapDiagnostics.update(requestId, {
            outcome: 'error',
            failure: 'publication-deadline',
          })
          setState((previous) => ({ ...previous, status: 'error', message: failure }))
        }, PUBLICATION_TIMEOUT_MS)
      if (tiles.length === 0) {
        activePatterns.clear()
        setState({ snapshots: [null, null], activeBuffer: null, status: 'idle', message: '' })
      } else {
        setState((previous) => ({
          ...previous,
          status: 'loading',
          message: 'Updating overlap stripes…',
        }))
      }
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(refresh, 120)
    }
    refreshRef.current = () => {
      suspendCoverage()
      setState({ snapshots: [null, null], activeBuffer: null, status: 'idle', message: '' })
      schedule()
    }
    worker.onmessage = ({ data: response }: MessageEvent<OverlapResponse>) => {
      if (response.requestId !== requestId || !requestHasTiles) return
      if ('tile' in response) {
        const vertices =
          [...results.values()].reduce((sum, tile) => sum + tile.vertices, 0) +
          response.tile.vertices
        if (vertices > 200_000 || failure) {
          if (!failure) {
            clearTimeout(deadline)
            worker.cancel()
            failure =
              'Overlap geometry exceeds the preview budget. Zoom in or select fewer languages.'
            overlapDiagnostics.update(requestId, { outcome: 'error', failure: 'output-vertices' })
            setState((previous) => ({ ...previous, status: 'error', message: failure }))
          }
          return
        }
        results.set(tileKey(response.tile.tile), response.tile)
        version++
        overlapDiagnostics.update(requestId, {
          deliveredTiles: (report()?.deliveredTiles ?? 0) + 1,
        })
        if (!pendingResult && publicationTimer === undefined)
          // Fast requests publish once on completion. Give them a short grace
          // period before paying for an intermediate source/fallback rebuild.
          publicationTimer = setTimeout(
            stageCoverage,
            Math.max(32, 250 - (performance.now() - requestStartedAt)),
          )
        return
      }
      overlapDiagnostics.response(response)
      overlapDiagnostics.update(requestId, { workerRestarts: worker.restarts })
      complete = true
      if ('error' in response) {
        clearTimeout(deadline)
        failure = response.error
        overlapDiagnostics.update(requestId, { outcome: 'error', failure: response.failure })
        setState((previous) => ({
          ...previous,
          status: 'error',
          message: `${response.error} Keeping available coverage; solid colors show other areas.`,
        }))
        return
      }
      stageCoverage()
      // A request containing only retained tiles, or whose last batch already
      // published, has no additional source work to wait for.
      if (!pendingResult && publishedVersion === version && !failure) {
        clearTimeout(deadline)
        const currentReport = report()
        overlapDiagnostics.update(requestId, {
          outcome: 'ready',
          totalMs: currentReport ? performance.now() - currentReport.startedAt : 0,
          buffer: activeBuffer ?? 0,
        })
        setState((previous) => ({
          ...previous,
          status: 'ready',
          message: readyMessage(),
        }))
      }
    }
    worker.onerror = () => {
      clearTimeout(deadline)
      failure = 'Could not calculate overlap stripes. Try reloading the map.'
      overlapDiagnostics.update(requestId, { outcome: 'error', failure: 'worker-error' })
      setState((previous) => ({ ...previous, status: 'error', message: failure }))
    }
    const prunePatterns = () => {
      if (!map.isStyleLoaded()) return
      const sources = BUFFERS.map((buffer) => `${OVERLAP_SOURCE}-${buffer}`)
      if (sources.some((id) => map.getSource(id) && !map.isSourceLoaded(id))) return
      const referencedPatterns = new Set(
        sources.flatMap((id) =>
          map.getSource(id)
            ? map
                .querySourceFeatures(id, { sourceLayer: COVERAGE_LAYER })
                .map(({ properties }) => properties.pattern)
            : [],
        ),
      )
      for (const id of ownedPatterns) {
        if (activePatterns.has(id) || referencedPatterns.has(id)) continue
        if (map.hasImage(id)) map.removeImage(id)
        ownedPatterns.delete(id)
      }
    }
    map.on('load', schedule)
    map.on('moveend', schedule)
    map.on('resize', schedule)
    map.on('idle', prunePatterns)
    map.on('idle', schedule)
    map.on('sourcedata', publishCoverage)
    map.on('idle', publishCoverage)
    schedule()
    return () => {
      clearTimeout(timer)
      clearTimeout(publicationTimer)
      clearTimeout(deadline)
      refreshRef.current = null
      worker.terminate()
      releaseUnused([])
      map.off('load', schedule)
      map.off('moveend', schedule)
      map.off('resize', schedule)
      map.off('idle', prunePatterns)
      map.off('idle', schedule)
      map.off('sourcedata', publishCoverage)
      map.off('idle', publishCoverage)
      if (map.isStyleLoaded())
        for (const id of ownedPatterns) if (map.hasImage(id)) map.removeImage(id)
    }
  }, [map, data, onCoverageReady, targetLayerId])

  useEffect(() => {
    configRef.current = { selectionKey, mode }
    refreshRef.current?.()
  }, [selectionKey, mode])

  const showExample = () => {
    setPeriod('contemporary')
    setDatasetFilter(['asher2007world'])
    setVisibleIds(EXAMPLE_LANGUAGE_IDS)
    setMode('hatching')
    map?.flyTo({ center: [-4.5, 54.2], zoom: 4.4, duration: 900 })
  }

  return (
    <>
      {BUFFERS.map((buffer) => {
        const snapshot = state.snapshots[buffer]
        return (
          snapshot && (
            <Fragment key={buffer}>
              <Source
                key={`${buffer}-${snapshot.maxzoom}`}
                id={`${OVERLAP_SOURCE}-${buffer}`}
                type="vector"
                tiles={[snapshot.url]}
                minzoom={0}
                maxzoom={snapshot.maxzoom}
              >
                <Layer
                  id={`${OVERLAP_LAYER}-${buffer}`}
                  source-layer={COVERAGE_LAYER}
                  type="fill"
                  {...(beforeId ? { beforeId } : {})}
                  paint={{
                    'fill-pattern': ['get', 'pattern'],
                    'fill-opacity': 1,
                    'fill-layer-opacity':
                      coverageReady && state.activeBuffer === buffer ? opacity : 0,
                    'fill-layer-opacity-transition': { duration: 0 },
                    'fill-antialias': true,
                  }}
                />
              </Source>
              <Source
                id={`${FALLBACK_SOURCE}-${buffer}`}
                type="vector"
                tiles={[fallbackTilesUrl(languageArchiveUrl(), snapshot.coverageTiles)]}
                minzoom={0}
                maxzoom={8}
              >
                <Layer
                  id={`${FALLBACK_SOURCE}-${buffer}`}
                  source-layer={data.manifest.vectorLayer}
                  type="fill"
                  filter={['in', ['get', 'variant_id'], ['literal', variants.map(({ id }) => id)]]}
                  {...(beforeId ? { beforeId } : {})}
                  paint={{
                    'fill-color': ['get', 'color'],
                    'fill-opacity': 1,
                    'fill-layer-opacity':
                      coverageReady && state.activeBuffer === buffer ? opacity : 0,
                    'fill-layer-opacity-transition': { duration: 0 },
                    'fill-antialias': false,
                  }}
                />
              </Source>
            </Fragment>
          )
        )
      })}
      {showControls && (
        <div className="map-overlap-control">
          <label>
            <span>Overlapping languages</span>
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.currentTarget.value === 'blending' ? 'blending' : 'hatching')
              }
            >
              <option value="hatching">Alternating stripes</option>
              <option value="blending">Color blending</option>
            </select>
          </label>
          {mode === 'hatching' && (
            <label className="map-opacity-control" htmlFor="language-opacity">
              <span>
                Color strength{' '}
                <output htmlFor="language-opacity">{Math.round(opacity * 100)}%</output>
              </span>
              <input
                id="language-opacity"
                type="range"
                min="40"
                max="100"
                value={Math.round(opacity * 100)}
                onChange={(event) => setOpacity(Number(event.currentTarget.value) / 100)}
              />
            </label>
          )}
          <button type="button" onClick={showExample}>
            Try Britain example
          </button>
          <p role="status" data-overlap-status={state.status}>
            {mode === 'blending'
              ? 'Overlapping colors are blended'
              : variants.length < 2
                ? 'Select two or more languages, or try the example'
                : state.message || 'Preparing overlap stripes…'}
          </p>
        </div>
      )}
    </>
  )
}
