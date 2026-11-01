import type { Feature, FeatureCollection, Geometry } from 'geojson'
import iso3166 from 'iso-3166-1'
import { useAtomValue } from 'jotai'
import type { ExpressionSpecification, FilterSpecification, MapLayerMouseEvent } from 'maplibre-gl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapView, {
  Layer,
  type MapRef,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  Source,
} from 'react-map-gl/maplibre'
import { feature as topojsonFeature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import countryTopologyUrl from 'world-atlas/countries-50m.json?url'
import { languageArchiveUrl, normalizeLanguageQuery } from '../../data/atlasRepository'
import type { TemporalViewSelection } from '../../domain/atlas'
import {
  type CldrGeographySelection,
  type CldrMetric,
  type CldrObservation,
  canonicalCldrObservations,
  cldrGeometryVariants,
} from '../../domain/cldr'
import { isTemporalViewSelection, TEMPORAL_VIEWS } from '../../domain/temporal'
import {
  atlasDataAtom,
  cldrDataAtom,
  languageOpacityAtom,
  overlapModeAtom,
} from '../../state/atlasState'
import { OverlapHatching } from '../map/overlap/OverlapHatching'
import './cldrMap.css'

const CARTO_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
const COUNTRY_LAYER_ID = 'cldr-country-fill'
const COUNTRY_HIT_LAYER_ID = 'cldr-country-hit'
const COUNTRY_AREA_MASK_LAYER_ID = 'cldr-selected-country-area-mask'
const LANGUAGE_AREA_LAYER_ID = 'cldr-language-areas'
const LANGUAGE_AREA_HIT_LAYER_ID = 'cldr-language-area-hit'
const ZOOM_GLOBAL = 2.8
const ZOOM_COUNTRY = 5.2
const FAMILY_COLORS = [
  '#bd5d3c',
  '#477ca8',
  '#638a54',
  '#9b6aa2',
  '#c48b37',
  '#347f78',
  '#d17b85',
  '#7061a8',
  '#71853b',
  '#b66b3c',
]
const OFFICIAL_COLORS: Readonly<Record<string, string>> = {
  official: '#4f956b',
  official_regional: '#478ed1',
  de_facto_official: '#899b65',
  unspecified: '#9da7a3',
}

interface CountryProperties {
  readonly territoryCode: string
  readonly countryName: string
  readonly literacyPercent: number | null
  readonly diversityIndex: number | null
  readonly longitude: number
  readonly latitude: number
}

type CountryCollection = FeatureCollection<Geometry, CountryProperties>

interface CountrySummary {
  readonly code: string
  readonly name: string
  readonly observations: readonly CldrObservation[]
  readonly speakerCount: number
  readonly literacyPercent: number | null
  readonly diversityIndex: number | null
}

interface FamilySummary {
  readonly id: string
  readonly name: string
  readonly speakerCount: number
  readonly languageCount: number
  readonly longitude: number | null
  readonly latitude: number | null
}

type DrawerSelection =
  | {
      readonly kind: 'country'
      readonly code: string
      readonly highlightLanguages?: boolean
    }
  | {
      readonly kind: 'language'
      readonly languageId: string
      readonly territoryCode: string | null
    }
  | { readonly kind: 'family'; readonly familyId: string }
  | null

type SearchResult =
  | {
      readonly kind: 'country'
      readonly key: string
      readonly label: string
      readonly detail: string
      readonly code: string
    }
  | {
      readonly kind: 'language'
      readonly key: string
      readonly label: string
      readonly detail: string
      readonly languageId: string
      readonly territoryCode: string
      readonly longitude: number | null
      readonly latitude: number | null
      readonly geometryLanguageId: string | null
    }
  | {
      readonly kind: 'family'
      readonly key: string
      readonly label: string
      readonly detail: string
      readonly familyId: string
      readonly longitude: number | null
      readonly latitude: number | null
    }

interface HoveredLanguageArea {
  readonly variantId: string
  readonly longitude: number
  readonly latitude: number
}

const countryNameFor = (code: string) =>
  iso3166.whereAlpha2(code)?.country ??
  new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ??
  code

const longitudeArc = (longitudes: readonly number[]) => {
  const values = [...new Set(longitudes.map((longitude) => (longitude + 360) % 360))].sort(
    (left, right) => left - right,
  )
  if (values.length === 0) return null
  let largestGap = -1
  let gapIndex = values.length - 1
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index]
    const next = values[(index + 1) % values.length]
    if (current === undefined || next === undefined) continue
    const gap = (index === values.length - 1 ? next + 360 : next) - current
    if (gap > largestGap) {
      largestGap = gap
      gapIndex = index
    }
  }
  const start = values[(gapIndex + 1) % values.length]
  const last = values[gapIndex]
  if (start === undefined || last === undefined) return null
  const end = gapIndex === values.length - 1 ? last : last + 360
  const wrap = (longitude: number) => ((((longitude + 180) % 360) + 360) % 360) - 180
  return {
    west: wrap(start),
    east: wrap(end),
    center: wrap((start + end) / 2),
  }
}

const countryBoundsCenter = (geometry: Geometry) => {
  const longitudes: number[] = []
  const latitudes: number[] = []
  const collect = (coordinates: unknown) => {
    if (!Array.isArray(coordinates)) return
    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === 'number' &&
      typeof coordinates[1] === 'number'
    ) {
      longitudes.push(coordinates[0])
      latitudes.push(coordinates[1])
      return
    }
    for (const coordinate of coordinates) collect(coordinate)
  }
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    collect(geometry.coordinates)
  }
  if (longitudes.length === 0 || latitudes.length === 0) return null

  const arc = longitudeArc(longitudes)
  if (!arc) return null
  return {
    longitude: arc.center,
    latitude: (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
  }
}

const geometryBounds = (geometry: Geometry): [[number, number], [number, number]] | null => {
  const coordinates: [number, number][] = []
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      coordinates.push([value[0], value[1]])
      return
    }
    for (const child of value) collect(child)
  }
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    collect(geometry.coordinates)
  }
  if (coordinates.length === 0) return null
  const arc = longitudeArc(coordinates.map(([longitude]) => longitude))
  if (!arc) return null
  const south = Math.min(...coordinates.map(([, latitude]) => latitude))
  const north = Math.max(...coordinates.map(([, latitude]) => latitude))
  return [
    [arc.west, south],
    [arc.east, north],
  ]
}

const normalizedDiversity = (observations: readonly CldrObservation[]) => {
  const percentages = observations
    .map((observation) => observation.populationPercent ?? 0)
    .filter((percentage) => percentage > 0)
  if (percentages.length < 2) return 0

  const total = percentages.reduce((sum, percentage) => sum + percentage, 0)
  const entropy = percentages.reduce((sum, percentage) => {
    const share = percentage / total
    return sum - share * Math.log(share)
  }, 0)
  return entropy / Math.log(percentages.length)
}

const groupBy = (
  observations: readonly CldrObservation[],
  key: (row: CldrObservation) => string,
) => {
  const groups = new Map<string, CldrObservation[]>()
  for (const observation of observations) {
    const groupKey = key(observation)
    if (!groupKey) continue
    const group = groups.get(groupKey)
    if (group) group.push(observation)
    else groups.set(groupKey, [observation])
  }
  return groups
}

const makeCountrySummaries = (observations: readonly CldrObservation[]) => {
  const rowsByTerritory = groupBy(observations, (observation) => observation.territoryCode)
  const summaries = new Map<string, CountrySummary>()
  for (const [code, rows] of rowsByTerritory) {
    const first = rows[0]
    if (!first) continue
    const uniqueLanguages = [...new Map(rows.map((row) => [row.languageId, row])).values()]
    summaries.set(code, {
      code,
      name: countryNameFor(code),
      observations: uniqueLanguages,
      speakerCount: uniqueLanguages.reduce((sum, row) => sum + (row.speakerCount ?? 0), 0),
      literacyPercent: first.territoryLiteracyPercent,
      diversityIndex: normalizedDiversity(uniqueLanguages),
    })
  }
  return summaries
}

const makeFamilySummaries = (
  observations: readonly CldrObservation[],
  familyNames: ReadonlyMap<string, string>,
) => {
  const rowsByLanguage = groupBy(observations, (observation) => observation.languageId)
  const rowsByFamily = groupBy(observations, (observation) => observation.familyId ?? '')
  const families: FamilySummary[] = []

  for (const [id, rows] of rowsByFamily) {
    const languages = new Map<string, CldrObservation[]>()
    for (const row of rows) {
      const languageRows = languages.get(row.languageId)
      if (languageRows) languageRows.push(row)
      else languages.set(row.languageId, [row])
    }
    let weightedLongitude = 0
    let weightedLatitude = 0
    let coordinateWeight = 0
    for (const [languageId, languageRows] of languages) {
      const first = languageRows[0]
      if (!first || first.longitude === null || first.latitude === null) continue
      const weight =
        rowsByLanguage.get(languageId)?.reduce((sum, row) => sum + (row.speakerCount ?? 0), 0) ?? 0
      const safeWeight = Math.max(weight, 1)
      weightedLongitude += first.longitude * safeWeight
      weightedLatitude += first.latitude * safeWeight
      coordinateWeight += safeWeight
    }
    families.push({
      id,
      name: familyNames.get(id) ?? id,
      speakerCount: rows.reduce((sum, row) => sum + (row.speakerCount ?? 0), 0),
      languageCount: languages.size,
      longitude: coordinateWeight ? weightedLongitude / coordinateWeight : null,
      latitude: coordinateWeight ? weightedLatitude / coordinateWeight : null,
    })
  }
  return families.sort((left, right) => right.speakerCount - left.speakerCount)
}

const loadCountryBoundaries = async (): Promise<FeatureCollection<Geometry>> => {
  const response = await fetch(countryTopologyUrl)
  if (!response.ok) {
    throw new Error(`Could not load country boundaries: ${response.status} ${response.statusText}`)
  }
  const topology = (await response.json()) as Topology
  const countryObject = topology.objects.countries
  if (countryObject?.type !== 'GeometryCollection') {
    throw new Error('Country boundary topology did not contain country geometries')
  }
  const countries = topojsonFeature(topology, countryObject)
  if (countries.type !== 'FeatureCollection') {
    throw new Error('Country boundary topology did not contain a feature collection')
  }
  return countries
}

const createCountryCollection = (
  boundaries: FeatureCollection<Geometry>,
  summaries: ReadonlyMap<string, CountrySummary>,
): CountryCollection => ({
  type: 'FeatureCollection',
  features: boundaries.features.flatMap((boundary): Feature<Geometry, CountryProperties>[] => {
    const numericCode = String(boundary.id ?? '').padStart(3, '0')
    const isoCountry = iso3166.whereNumeric(numericCode)
    if (!isoCountry || !boundary.geometry) return []
    const center = countryBoundsCenter(boundary.geometry)
    const summary = summaries.get(isoCountry.alpha2)
    if (!center) return []
    return [
      {
        ...boundary,
        properties: {
          territoryCode: isoCountry.alpha2,
          countryName: summary?.name ?? isoCountry.country,
          literacyPercent: summary?.literacyPercent ?? null,
          diversityIndex: summary?.diversityIndex ?? null,
          longitude: center.longitude,
          latitude: center.latitude,
        },
      },
    ]
  }),
})

const visibleWithin = (
  longitude: number | null,
  latitude: number | null,
  bounds: readonly [number, number, number, number],
) =>
  longitude !== null &&
  latitude !== null &&
  longitude >= bounds[0] &&
  longitude <= bounds[2] &&
  latitude >= bounds[1] &&
  latitude <= bounds[3]

const formatCount = (value: number) =>
  Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)

const formatPercent = (value: number | null) =>
  value === null
    ? 'Not available'
    : `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)}%`

const statusColor = (status: string) => OFFICIAL_COLORS[status] ?? OFFICIAL_COLORS.unspecified

const statusLabel = (status: string) => {
  switch (status) {
    case 'official':
      return 'Official'
    case 'official_regional':
      return 'Regional official'
    case 'de_facto_official':
      return 'De facto official'
    default:
      return 'Unspecified / minority'
  }
}

const primaryObservation = (rows: readonly CldrObservation[]) =>
  rows.reduce<CldrObservation | undefined>(
    (largest, row) =>
      !largest || (row.speakerCount ?? 0) > (largest.speakerCount ?? 0) ? row : largest,
    undefined,
  )

const donutBackground = (rows: readonly CldrObservation[]) => {
  const total = rows.reduce((sum, row) => sum + Math.max(row.populationPercent ?? 0, 0), 0)
  if (total <= 0) return `conic-gradient(${OFFICIAL_COLORS.unspecified} 0 100%)`
  let start = 0
  const segments = rows
    .slice()
    .sort((left, right) => (right.populationPercent ?? 0) - (left.populationPercent ?? 0))
    .map((row) => {
      const end = start + (Math.max(row.populationPercent ?? 0, 0) / total) * 100
      const segment = `${statusColor(row.officialStatus)} ${start}% ${end}%`
      start = end
      return segment
    })
  return `conic-gradient(${segments.join(', ')})`
}

const familyColor = (id: string) => {
  let hash = 0
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return FAMILY_COLORS[Math.abs(hash) % FAMILY_COLORS.length] ?? FAMILY_COLORS[0]
}

const metricExpression = (metric: CldrMetric): ExpressionSpecification =>
  metric === 'literacy'
    ? [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'literacyPercent'], 0],
        0,
        '#f1eee5',
        50,
        '#c5d5be',
        100,
        '#4f806b',
      ]
    : [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'diversityIndex'], 0],
        0,
        '#f1eee5',
        0.5,
        '#c5d5be',
        1,
        '#4f806b',
      ]

const AppSearch = ({
  results,
  query,
  setQuery,
  onChoose,
}: {
  readonly results: readonly SearchResult[]
  readonly query: string
  readonly setQuery: (query: string) => void
  readonly onChoose: (result: SearchResult) => void
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const matches = useMemo(() => {
    const normalized = normalizeLanguageQuery(query.trim())
    if (!normalized) return []
    return results
      .filter(
        (result) =>
          normalizeLanguageQuery(`${result.label} ${result.detail}`).includes(normalized) ||
          normalizeLanguageQuery(result.key).includes(normalized),
      )
      .sort((left, right) => {
        const score = (result: SearchResult) =>
          normalizeLanguageQuery(result.label) === normalized ||
          normalizeLanguageQuery(result.key) === normalized
            ? 0
            : 1
        return score(left) - score(right)
      })
      .slice(0, 8)
  }, [query, results])

  useEffect(() => {
    if (!isOpen) return

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isOpen])

  return (
    <div className="cldr-search" ref={rootRef}>
      <label className="cldr-search__field">
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          role="combobox"
          value={query}
          placeholder="Search a language, country, family or Glottocode"
          aria-label="Search a language, country, family or Glottocode"
          aria-expanded={isOpen && matches.length > 0}
          aria-autocomplete="list"
          aria-controls="cldr-search-results"
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setIsOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && matches[0]) {
              event.preventDefault()
              onChoose(matches[0])
              setIsOpen(false)
            }
            if (event.key === 'Escape') setIsOpen(false)
          }}
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </label>
      {isOpen && query && (
        <div className="cldr-search__results" id="cldr-search-results" role="listbox">
          {matches.length ? (
            matches.map((result) => (
              <button
                type="button"
                role="option"
                aria-selected="false"
                key={`${result.kind}:${result.key}`}
                onClick={() => {
                  onChoose(result)
                  setIsOpen(false)
                }}
              >
                <span className="cldr-search__result-icon" aria-hidden="true">
                  {result.kind === 'country' ? '⌖' : result.kind === 'family' ? '◉' : '●'}
                </span>
                <span>
                  <strong>{result.label}</strong>
                  <small>{result.detail}</small>
                </span>
              </button>
            ))
          ) : (
            <p>No matching languages, territories or families</p>
          )}
        </div>
      )}
    </div>
  )
}

const LanguageDetail = ({
  observation,
  rawVariants,
}: {
  readonly observation: CldrObservation
  readonly rawVariants: readonly CldrObservation[]
}) => (
  <>
    <div className="cldr-detail__identity">
      <span className="cldr-detail__eyebrow">
        CLDR {observation.glottologLevel} · {observation.languageRawCode ?? 'no raw code'}
      </span>
      <h2>{observation.languageName}</h2>
      <code>{observation.languageId}</code>
    </div>
    <p className="cldr-detail__note">
      The outlined shape is the selected atlas language area. Highlighted country donuts mark
      territories with CLDR records for this language; they are not language-origin coordinates.
    </p>
    {observation.glottologLevel === 'dialect' && observation.geometryLanguageId && (
      <p className="cldr-detail__note">
        This dialect maps to the Glottolog language area {observation.geometryLanguageId}; source
        polygons are available at language level.
      </p>
    )}
    {observation.glottologLevel === 'family' && (
      <p className="cldr-detail__note">
        CLDR maps this code to a Glottolog family node. The map uses its Glottolog coordinate; there
        is no language-level polygon for this family ID.
      </p>
    )}
    {rawVariants.length > 0 && (
      <p className="cldr-detail__note">
        Other CLDR code variants for this Glottocode in this territory:{' '}
        {[...new Set(rawVariants.map((variant) => variant.languageRawCode).filter(Boolean))].join(
          ', ',
        )}
        . The largest reported estimate is used in country totals to avoid counting the same
        Glottocode twice.
      </p>
    )}
    <dl className="cldr-detail__stats">
      <div>
        <dt>Speakers in {countryNameFor(observation.territoryCode)}</dt>
        <dd>{(observation.speakerCount ?? 0).toLocaleString()}</dd>
      </div>
      <div>
        <dt>Share of country population</dt>
        <dd>{formatPercent(observation.populationPercent)}</dd>
      </div>
      <div>
        <dt>Official status</dt>
        <dd>{statusLabel(observation.officialStatus)}</dd>
      </div>
      <div>
        <dt>Country literacy</dt>
        <dd>{formatPercent(observation.territoryLiteracyPercent)}</dd>
      </div>
      <div>
        <dt>Country GDP (USD)</dt>
        <dd>
          {observation.territoryGdpUsd === null
            ? 'Not available'
            : `$${formatCount(observation.territoryGdpUsd)}`}
        </dd>
      </div>
    </dl>
    <div className="cldr-detail__links">
      <span>Related views</span>
      <button type="button" disabled title="WALS module is not part of this app yet">
        WALS phonology · unavailable
      </button>
      <button type="button" disabled title="DiACL vocabulary module is not part of this app yet">
        DiACL vocabulary · unavailable
      </button>
    </div>
  </>
)

export const CldrMapView = () => {
  const rawObservations = useAtomValue(cldrDataAtom)
  const observations = useMemo(() => canonicalCldrObservations(rawObservations), [rawObservations])
  const atlas = useAtomValue(atlasDataAtom)
  const overlapMode = useAtomValue(overlapModeAtom)
  const languageOpacity = useAtomValue(languageOpacityAtom)
  const mapRef = useRef<MapRef>(null)
  const [metric, setMetric] = useState<CldrMetric>('diversity')
  const [geographySource, setGeographySource] = useState<CldrGeographySelection>('all')
  const [geographyPeriod, setGeographyPeriod] = useState<TemporalViewSelection>('contemporary')
  const [query, setQuery] = useState('')
  const [zoom, setZoom] = useState(1.7)
  const [bounds, setBounds] = useState<readonly [number, number, number, number]>([
    -180, -85, 180, 85,
  ])
  const [drawer, setDrawer] = useState<DrawerSelection>(null)
  const [hoveredArea, setHoveredArea] = useState<HoveredLanguageArea | null>(null)
  const [countryFeatures, setCountryFeatures] = useState<FeatureCollection<Geometry> | null>(null)
  const [boundaryError, setBoundaryError] = useState('')
  const [coverageSelection, setCoverageSelection] = useState<{
    readonly key: string
    readonly drawer: DrawerSelection
  } | null>(null)
  const [hatchingError, setHatchingError] = useState<{
    readonly drawer: DrawerSelection
    readonly message: string
  } | null>(null)

  const familyNames = useMemo(
    () =>
      new Map(
        atlas.languages.flatMap((language) =>
          language.familyId && language.familyName
            ? [[language.familyId, language.familyName] as const]
            : [],
        ),
      ),
    [atlas.languages],
  )
  const countries = useMemo(() => makeCountrySummaries(observations), [observations])
  const countryFeaturesForMap = useMemo(
    () => (countryFeatures ? createCountryCollection(countryFeatures, countries) : null),
    [countryFeatures, countries],
  )
  const countryCenters = useMemo(
    () =>
      new Map(
        countryFeaturesForMap?.features.map((feature) => [
          feature.properties.territoryCode,
          {
            longitude: feature.properties.longitude,
            latitude: feature.properties.latitude,
          },
        ]) ?? [],
      ),
    [countryFeaturesForMap],
  )
  const countryBounds = useMemo(
    () =>
      new Map(
        countryFeaturesForMap?.features.flatMap((feature) => {
          const bounds = feature.geometry ? geometryBounds(feature.geometry) : null
          return bounds ? [[feature.properties.territoryCode, bounds] as const] : []
        }) ?? [],
      ),
    [countryFeaturesForMap],
  )
  const families = useMemo(
    () => makeFamilySummaries(observations, familyNames),
    [observations, familyNames],
  )
  const languageRows = useMemo(() => groupBy(observations, (row) => row.languageId), [observations])
  const rawLanguageRows = useMemo(
    () => groupBy(rawObservations, (row) => `${row.territoryCode}:${row.languageId}`),
    [rawObservations],
  )
  const rowsByGeometryLanguageId = useMemo(
    () => groupBy(observations, (row) => row.geometryLanguageId ?? ''),
    [observations],
  )
  const familyRows = useMemo(
    () => groupBy(observations, (row) => row.familyId ?? ''),
    [observations],
  )
  const selectedGeometryVariants = useMemo(
    () => cldrGeometryVariants(atlas, observations, geographySource, geographyPeriod),
    [atlas, observations, geographySource, geographyPeriod],
  )
  const selectedVariantIds = useMemo(
    () => [...selectedGeometryVariants.values()],
    [selectedGeometryVariants],
  )
  const geographySourceLabel =
    geographySource === 'all'
      ? 'Best available · all sources'
      : (atlas.datasets.find((dataset) => dataset.id === geographySource)?.shortName ??
        geographySource)

  const searchResults = useMemo<SearchResult[]>(() => {
    const countryResults: SearchResult[] = [...countries.values()].map((country) => ({
      kind: 'country',
      key: country.code,
      code: country.code,
      label: country.name,
      detail: `${country.code} · ${country.observations.length} mapped languages`,
    }))
    const languageResults: SearchResult[] = [...languageRows].flatMap(([languageId, rows]) => {
      const language = primaryObservation(rows)
      if (!language) return []
      return [
        {
          kind: 'language' as const,
          key: languageId,
          languageId,
          territoryCode: language.territoryCode,
          label: language.languageName,
          detail: `${languageId} · ${countryNameFor(language.territoryCode)}`,
          longitude:
            (language.geometryLanguageId
              ? atlas.languageById.get(language.geometryLanguageId)?.longitude
              : null) ?? language.longitude,
          latitude:
            (language.geometryLanguageId
              ? atlas.languageById.get(language.geometryLanguageId)?.latitude
              : null) ?? language.latitude,
          geometryLanguageId: language.geometryLanguageId,
        },
      ]
    })
    const familyResults: SearchResult[] = families.map((family) => ({
      kind: 'family',
      key: family.id,
      familyId: family.id,
      label: family.name,
      detail: `${family.id} · ${family.languageCount} languages`,
      longitude: family.longitude,
      latitude: family.latitude,
    }))
    return [...languageResults, ...countryResults, ...familyResults]
  }, [atlas.languageById, countries, families, languageRows])

  useEffect(() => {
    loadCountryBoundaries()
      .then(setCountryFeatures)
      .catch((error: unknown) => {
        setBoundaryError(error instanceof Error ? error.message : String(error))
      })
  }, [])

  const selectedCountry = drawer?.kind === 'country' ? countries.get(drawer.code) : undefined
  const selectedLanguage =
    drawer?.kind === 'language'
      ? (languageRows
          .get(drawer.languageId)
          ?.find((row) => row.territoryCode === drawer.territoryCode) ??
        languageRows.get(drawer.languageId)?.[0])
      : undefined
  const selectedLanguageRawVariants = selectedLanguage
    ? (
        rawLanguageRows.get(`${selectedLanguage.territoryCode}:${selectedLanguage.languageId}`) ??
        []
      ).filter((row) => row.languageRawCode !== selectedLanguage.languageRawCode)
    : []
  const selectedFamily =
    drawer?.kind === 'family' ? families.find((family) => family.id === drawer.familyId) : undefined
  const selectedCountryRows = selectedCountry?.observations ?? []
  const selectedLanguageIds = useMemo(() => {
    if (drawer?.kind === 'language') return new Set([drawer.languageId])
    if (drawer?.kind === 'country' && drawer.highlightLanguages) {
      return new Set((countries.get(drawer.code)?.observations ?? []).map((row) => row.languageId))
    }
    return new Set<string>()
  }, [countries, drawer])
  const selectedCountryCodes = useMemo(() => {
    if (drawer?.kind === 'country') return new Set([drawer.code])
    if (drawer?.kind === 'language') {
      return new Set((languageRows.get(drawer.languageId) ?? []).map((row) => row.territoryCode))
    }
    return new Set<string>()
  }, [drawer, languageRows])
  const selectedGeometryLanguageIds = useMemo(() => {
    const languageIds = new Set<string>()
    for (const languageId of selectedLanguageIds) {
      for (const row of languageRows.get(languageId) ?? []) {
        if (row.geometryLanguageId) languageIds.add(row.geometryLanguageId)
      }
    }
    return languageIds
  }, [languageRows, selectedLanguageIds])
  const selectedAreaVariantIds = useMemo(
    () =>
      [...selectedGeometryLanguageIds].flatMap((languageId) => {
        const variantId = selectedGeometryVariants.get(languageId)
        return variantId ? [variantId] : []
      }),
    [selectedGeometryLanguageIds, selectedGeometryVariants],
  )
  const selectedAreaVariants = useMemo(
    () =>
      selectedAreaVariantIds.flatMap((variantId) => {
        const variant = atlas.variantById.get(variantId)
        return variant ? [variant] : []
      }),
    [atlas.variantById, selectedAreaVariantIds],
  )
  const overlapSelectionKey = JSON.stringify([...selectedAreaVariantIds].sort())
  const pieLanguagesSelected = drawer?.kind === 'country' && drawer.highlightLanguages === true
  const hoveredVariant = hoveredArea ? atlas.variantById.get(hoveredArea.variantId) : undefined
  const hoveredLanguage = hoveredVariant
    ? atlas.languageById.get(hoveredVariant.languageId)
    : undefined
  const hoveredObservation =
    pieLanguagesSelected && hoveredVariant
      ? selectedCountry?.observations.find(
          (row) => row.geometryLanguageId === hoveredVariant.languageId,
        )
      : undefined
  const countryMaskData = useMemo<CountryCollection>(
    () => ({
      type: 'FeatureCollection',
      features:
        pieLanguagesSelected && selectedCountry && countryFeaturesForMap
          ? countryFeaturesForMap.features.filter(
              (feature) => feature.properties.territoryCode !== selectedCountry.code,
            )
          : [],
    }),
    [countryFeaturesForMap, pieLanguagesSelected, selectedCountry],
  )
  useEffect(() => {
    if (!pieLanguagesSelected) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const orderMaskLayers = () => {
      const maskLayer = COUNTRY_AREA_MASK_LAYER_ID
      const maskOutline = 'cldr-selected-country-area-mask-outline'
      const countryBorders = 'cldr-selected-country-borders'
      if (!map.getLayer(maskLayer)) return
      const layers = map.getStyle().layers
      const symbolLayerIds = layers.filter((layer) => layer.type === 'symbol').map(({ id }) => id)
      for (const layer of layers) {
        if (
          layer.type === 'symbol' ||
          layer.id === maskLayer ||
          layer.id === maskOutline ||
          layer.id === countryBorders
        ) {
          continue
        }
        const order = map.getLayersOrder()
        if (order.indexOf(layer.id) > order.indexOf(maskLayer)) map.moveLayer(layer.id, maskLayer)
      }
      const firstSymbolLayer = symbolLayerIds[0]
      map.moveLayer(maskLayer, firstSymbolLayer)
      if (map.getLayer(maskOutline)) map.moveLayer(maskOutline, firstSymbolLayer)
      if (map.getLayer(countryBorders)) map.moveLayer(countryBorders, firstSymbolLayer)
    }
    orderMaskLayers()
    map.on('styledata', orderMaskLayers)
    map.on('idle', orderMaskLayers)
    return () => {
      map.off('styledata', orderMaskLayers)
      map.off('idle', orderMaskLayers)
    }
  }, [pieLanguagesSelected])
  const hatchCoverageReady =
    pieLanguagesSelected &&
    overlapMode === 'hatching' &&
    selectedAreaVariantIds.length > 1 &&
    coverageSelection?.key === overlapSelectionKey &&
    coverageSelection.drawer === drawer
  const onCoverageReady = useCallback(
    (key: string | null) => {
      setCoverageSelection(key ? { key, drawer } : null)
    },
    [drawer],
  )
  const onHatchingStatus = useCallback(
    (status: 'idle' | 'loading' | 'ready' | 'error', message: string) => {
      setHatchingError(status === 'error' ? { drawer, message } : null)
    },
    [drawer],
  )
  const getMapPadding = useCallback(() => {
    const width = mapRef.current?.getMap().getContainer().clientWidth ?? 0
    return {
      top: 80,
      right: 70,
      bottom: 70,
      left: Math.min(420, Math.max(120, width * 0.48)),
    }
  }, [])
  const fitMapToLocations = useCallback(
    (locations: readonly { longitude: number; latitude: number }[], maxZoom = 5.2) => {
      if (locations.length === 0) return
      const uniqueLocations = [
        ...new Map(
          locations.map((location) => [`${location.longitude}:${location.latitude}`, location]),
        ).values(),
      ]
      const longitudes = uniqueLocations.map((location) => location.longitude)
      const latitudes = uniqueLocations.map((location) => location.latitude)
      const arc = longitudeArc(longitudes)
      if (!arc) return
      const bounds: [[number, number], [number, number]] = [
        [arc.west, Math.min(...latitudes)],
        [arc.east, Math.max(...latitudes)],
      ]
      if (uniqueLocations.length === 1) {
        const location = uniqueLocations[0]
        if (location)
          mapRef.current?.flyTo({ center: [location.longitude, location.latitude], zoom: maxZoom })
        return
      }
      const map = mapRef.current
      const camera = map?.cameraForBounds(bounds, { padding: getMapPadding(), maxZoom })
      if (map && camera) map.flyTo({ ...camera, duration: 900 })
    },
    [getMapPadding],
  )
  const languageOrigin = useCallback(
    (row: CldrObservation) => {
      const geometryLanguage = row.geometryLanguageId
        ? atlas.languageById.get(row.geometryLanguageId)
        : undefined
      const longitude = geometryLanguage?.longitude ?? row.longitude
      const latitude = geometryLanguage?.latitude ?? row.latitude
      return longitude !== null && latitude !== null ? { longitude, latitude } : null
    },
    [atlas.languageById],
  )
  const fitCountryAndLanguageOrigins = useCallback(
    (code: string) => {
      const bounds = countryBounds.get(code)
      if (bounds)
        mapRef.current?.fitBounds(bounds, {
          padding: getMapPadding(),
          maxZoom: 7,
          duration: 900,
        })
    },
    [countryBounds, getMapPadding],
  )
  useEffect(() => {
    if (drawer?.kind === 'country') {
      fitCountryAndLanguageOrigins(drawer.code)
    } else if (drawer?.kind === 'language') {
      const locations = (languageRows.get(drawer.languageId) ?? []).flatMap((row) => {
        const origin = languageOrigin(row)
        const countryCenter = countryCenters.get(row.territoryCode)
        return [origin, countryCenter].filter(
          (location): location is { longitude: number; latitude: number } =>
            location !== null && location !== undefined,
        )
      })
      fitMapToLocations(locations, 3.2)
    }
  }, [
    countryCenters,
    drawer,
    fitCountryAndLanguageOrigins,
    fitMapToLocations,
    languageOrigin,
    languageRows,
  ])

  const chooseSearchResult = (result: SearchResult) => {
    if (result.kind === 'country') {
      setDrawer({ kind: 'country', code: result.code })
      return
    }
    if (result.kind === 'family') {
      setDrawer({ kind: 'family', familyId: result.familyId })
      if (result.longitude !== null && result.latitude !== null) {
        mapRef.current?.flyTo({ center: [result.longitude, result.latitude], zoom: 2.2 })
      }
      return
    }
    setDrawer({
      kind: 'language',
      languageId: result.languageId,
      territoryCode: result.territoryCode,
    })
  }

  const familyBubbleCandidates = families
    .filter((family) => family.longitude !== null && family.latitude !== null)
    .filter((family) => drawer?.kind !== 'family' || family.id === drawer.familyId)
    .slice(0, 16)
    .filter((family) => visibleWithin(family.longitude, family.latitude, bounds))
  const maxFamilySpeakers = Math.max(...families.map((family) => family.speakerCount), 1)
  const countryDonuts = [...countries.values()]
    .flatMap((country) => {
      const center = countryCenters.get(country.code)
      return center ? [{ ...country, ...center }] : []
    })
    .filter(
      (country) =>
        visibleWithin(country.longitude, country.latitude, bounds) ||
        selectedCountry?.code === country.code ||
        (drawer?.kind === 'language' &&
          country.observations.some((row) => row.languageId === drawer.languageId)),
    )
  const languageOriginMarkers =
    drawer?.kind === 'language' || pieLanguagesSelected
      ? [...selectedGeometryLanguageIds].flatMap((languageId) => {
          const language = atlas.languageById.get(languageId)
          return language?.longitude !== null &&
            language?.longitude !== undefined &&
            language.latitude !== null
            ? [
                {
                  id: languageId,
                  name: language.name,
                  longitude: language.longitude,
                  latitude: language.latitude,
                },
              ]
            : []
        })
      : []

  const fillExpression = metricExpression(metric)
  const countryFilter: FilterSpecification = ['has', 'territoryCode']
  const selectedCountryFilter: FilterSpecification =
    selectedCountryCodes.size > 0
      ? ['in', ['get', 'territoryCode'], ['literal', [...selectedCountryCodes]]]
      : ['==', ['get', 'territoryCode'], '']
  const selectedCountryFillFilter: FilterSpecification =
    drawer?.kind === 'country'
      ? ['in', ['get', 'territoryCode'], ['literal', [...selectedCountryCodes]]]
      : ['==', ['get', 'territoryCode'], '']
  const languageAreaHitFilter: FilterSpecification =
    selectedVariantIds.length > 0
      ? ['in', ['get', 'variant_id'], ['literal', selectedVariantIds]]
      : ['==', ['get', 'variant_id'], '']
  const languageAreaFilter: FilterSpecification =
    selectedAreaVariantIds.length > 0
      ? ['in', ['get', 'variant_id'], ['literal', selectedAreaVariantIds]]
      : ['==', ['get', 'variant_id'], '']
  const zoomHint =
    zoom < ZOOM_GLOBAL
      ? drawer?.kind === 'language'
        ? 'Language selected · related territories and origin'
        : drawer?.kind === 'country'
          ? drawer.highlightLanguages
            ? 'Selected pie · included language origins highlighted'
            : 'Country selected · border highlighted'
          : drawer?.kind === 'family'
            ? 'Selected language family · speaker total'
            : 'Global view · family speaker clusters'
      : zoom < ZOOM_COUNTRY
        ? drawer?.kind === 'language'
          ? 'Language selected · related countries and origin'
          : drawer?.kind === 'country'
            ? drawer.highlightLanguages
              ? 'Selected pie · included language origins highlighted'
              : 'Country selected · border highlighted'
            : drawer?.kind === 'family'
              ? 'Family selected · explore reported languages'
              : 'Regional view · language share by country'
        : drawer?.kind === 'language'
          ? 'Language origin · selected language'
          : drawer?.kind === 'country'
            ? drawer.highlightLanguages
              ? 'Country pie · included language origins highlighted'
              : 'Country boundary · select a pie to see its languages'
            : drawer?.kind === 'family'
              ? 'Selected family · choose a related language'
              : 'Local view · select a language area'

  return (
    <section className="cldr-workspace" aria-label="CLDR language demographics map">
      <div className="cldr-map-shell">
        <MapView
          ref={mapRef}
          initialViewState={{ longitude: 8, latitude: 18, zoom: 0.9 }}
          mapStyle={CARTO_STYLE}
          projection={{ type: 'mercator' }}
          minZoom={0.6}
          maxZoom={12}
          renderWorldCopies={false}
          onMouseMove={(event: MapLayerMouseEvent) => {
            const map = event.target
            const outsideSelectedCountry =
              pieLanguagesSelected &&
              map.getLayer(COUNTRY_AREA_MASK_LAYER_ID) !== undefined &&
              map.queryRenderedFeatures(event.point, {
                layers: [COUNTRY_AREA_MASK_LAYER_ID],
              }).length > 0
            const features =
              pieLanguagesSelected &&
              selectedCountry &&
              !outsideSelectedCountry &&
              map.getLayer(LANGUAGE_AREA_LAYER_ID)
                ? map.queryRenderedFeatures(event.point, {
                    layers: [LANGUAGE_AREA_LAYER_ID],
                  })
                : []
            const feature = features.find((candidate) => {
              const candidateId = candidate.properties?.variant_id
              const candidateVariant =
                typeof candidateId === 'string' ? atlas.variantById.get(candidateId) : undefined
              return (
                candidateVariant !== undefined &&
                selectedCountry?.observations.some(
                  (row) => row.geometryLanguageId === candidateVariant.languageId,
                ) === true
              )
            })
            const variantId = feature?.properties?.variant_id
            const variant =
              typeof variantId === 'string' ? atlas.variantById.get(variantId) : undefined
            const observation = variant
              ? selectedCountry?.observations.find(
                  (row) => row.geometryLanguageId === variant.languageId,
                )
              : undefined
            map.getCanvas().style.cursor = observation ? 'pointer' : ''
            if (!variant || !observation) {
              setHoveredArea(null)
              return
            }
            setHoveredArea({
              variantId: variant.id,
              longitude: event.lngLat.lng,
              latitude: event.lngLat.lat,
            })
          }}
          onMouseLeave={(event) => {
            event.target.getCanvas().style.cursor = ''
            setHoveredArea(null)
          }}
          onMoveEnd={(event) => {
            setZoom(event.viewState.zoom)
            const mapBounds = event.target.getBounds()
            setBounds([
              mapBounds.getWest(),
              mapBounds.getSouth(),
              mapBounds.getEast(),
              mapBounds.getNorth(),
            ])
          }}
          onClick={(event) => {
            if (zoom < ZOOM_COUNTRY && event.target.getLayer(COUNTRY_HIT_LAYER_ID)) {
              const [country] = event.target.queryRenderedFeatures(event.point, {
                layers: [COUNTRY_HIT_LAYER_ID],
              })
              const code = country?.properties?.territoryCode
              if (typeof code === 'string') {
                setDrawer({ kind: 'country', code })
                return
              }
            }
            if (zoom >= ZOOM_COUNTRY && event.target.getLayer(LANGUAGE_AREA_HIT_LAYER_ID)) {
              const [area] = event.target.queryRenderedFeatures(event.point, {
                layers: [LANGUAGE_AREA_HIT_LAYER_ID],
              })
              const geometryLanguageId = area?.properties?.language_id
              if (typeof geometryLanguageId === 'string') {
                const rows = rowsByGeometryLanguageId.get(geometryLanguageId) ?? []
                const observation =
                  (selectedCountry
                    ? rows.find((row) => row.territoryCode === selectedCountry.code)
                    : undefined) ?? primaryObservation(rows)
                if (observation) {
                  setDrawer({
                    kind: 'language',
                    languageId: observation.languageId,
                    territoryCode: observation.territoryCode,
                  })
                  return
                }
              }
            }
            if (!event.target.getLayer(COUNTRY_HIT_LAYER_ID)) return
            const [country] = event.target.queryRenderedFeatures(event.point, {
              layers: [COUNTRY_HIT_LAYER_ID],
            })
            const code = country?.properties?.territoryCode
            if (typeof code === 'string') setDrawer({ kind: 'country', code })
          }}
        >
          <Source
            id="cldr-country-polygons"
            type="geojson"
            data={countryFeaturesForMap ?? { type: 'FeatureCollection', features: [] }}
          >
            <Layer
              id={COUNTRY_HIT_LAYER_ID}
              type="fill"
              filter={countryFilter}
              paint={{ 'fill-color': '#000000', 'fill-opacity': 0 }}
            />
            <Layer
              id={COUNTRY_LAYER_ID}
              type="fill"
              filter={countryFilter}
              beforeId="place_country_2"
              paint={{
                'fill-color': ['case', selectedCountryFillFilter, fillExpression, '#ffffff'],
                'fill-opacity': ['case', selectedCountryFillFilter, 0.28, 0],
                'fill-outline-color': '#f8f6ee',
              }}
            />
            <Layer
              id="cldr-selected-country-borders"
              type="line"
              filter={selectedCountryFilter}
              paint={{
                'line-color': '#e77920',
                'line-opacity': 1,
                'line-width': 3,
              }}
            />
          </Source>

          <Source
            id="cldr-language-areas-source"
            type="vector"
            url={languageArchiveUrl()}
            attribution="Language areas: Asher & Moseley (2007), Wurm & Hattori (1981), Matsumae et al. (2021), Carling et al. (2025), Bouckaert et al. (2012)"
          >
            <Layer
              id={LANGUAGE_AREA_HIT_LAYER_ID}
              source="cldr-language-areas-source"
              source-layer={atlas.manifest.vectorLayer}
              type="fill"
              filter={languageAreaHitFilter}
              paint={{ 'fill-color': '#000000', 'fill-opacity': 0 }}
            />
            <Layer
              id={LANGUAGE_AREA_LAYER_ID}
              source="cldr-language-areas-source"
              source-layer={atlas.manifest.vectorLayer}
              type="fill"
              filter={languageAreaFilter}
              beforeId="place_country_2"
              paint={{
                'fill-color': ['get', 'color'],
                'fill-opacity': hatchCoverageReady ? 0 : overlapMode === 'blending' ? 0.58 : 1,
                'fill-layer-opacity': overlapMode === 'hatching' ? languageOpacity : 1,
                'fill-outline-color': '#fff1a8',
              }}
            />
            <Layer
              id="cldr-language-area-outlines"
              source="cldr-language-areas-source"
              source-layer={atlas.manifest.vectorLayer}
              type="line"
              filter={languageAreaFilter}
              beforeId="place_country_2"
              paint={{
                'line-color': '#fff1a8',
                'line-opacity': 1,
                'line-width': 2.5,
              }}
            />
          </Source>

          {pieLanguagesSelected && selectedAreaVariants.length > 1 && (
            <OverlapHatching
              variants={selectedAreaVariants}
              selectionKey={overlapSelectionKey}
              coverageReady={hatchCoverageReady}
              onCoverageReady={onCoverageReady}
              targetLayerId={LANGUAGE_AREA_LAYER_ID}
              inspectionLayerId={LANGUAGE_AREA_LAYER_ID}
              beforeId={COUNTRY_AREA_MASK_LAYER_ID}
              showControls={false}
              onStatus={onHatchingStatus}
            />
          )}

          <Source id="cldr-country-area-mask-source" type="geojson" data={countryMaskData}>
            <Layer
              id={COUNTRY_AREA_MASK_LAYER_ID}
              type="fill"
              paint={{ 'fill-color': '#fbf8f3', 'fill-opacity': pieLanguagesSelected ? 1 : 0 }}
            />
            <Layer
              id="cldr-selected-country-area-mask-outline"
              type="line"
              paint={{
                'line-color': '#d8d2c8',
                'line-opacity': pieLanguagesSelected ? 0.75 : 0,
                'line-width': 0.7,
              }}
            />
          </Source>

          {hoveredArea && hoveredObservation && hoveredLanguage && (
            <Popup
              longitude={hoveredArea.longitude}
              latitude={hoveredArea.latitude}
              anchor="top"
              offset={10}
              closeButton={false}
              closeOnClick={false}
              className="cldr-area-tooltip-popup"
            >
              <div className="cldr-area-tooltip">
                <strong>{hoveredObservation.languageName}</strong>
                <span>Family · {hoveredLanguage.familyName ?? 'Not available'}</span>
                <span>Speakers · {formatPercent(hoveredObservation.populationPercent)}</span>
                <span>Status · {statusLabel(hoveredObservation.officialStatus)}</span>
              </div>
            </Popup>
          )}

          {zoom < ZOOM_GLOBAL &&
            (drawer === null || drawer.kind === 'family') &&
            familyBubbleCandidates.map((family) => {
              const size = 22 + Math.round(34 * Math.sqrt(family.speakerCount / maxFamilySpeakers))
              return (
                <Marker
                  key={family.id}
                  longitude={family.longitude ?? 0}
                  latitude={family.latitude ?? 0}
                  anchor="center"
                >
                  <button
                    type="button"
                    className="cldr-family-bubble"
                    style={{
                      width: `${size}px`,
                      height: `${size}px`,
                      backgroundColor: familyColor(family.id),
                    }}
                    aria-label={`${family.name}, ${formatCount(family.speakerCount)} speakers`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setDrawer({ kind: 'family', familyId: family.id })
                    }}
                  >
                    {size > 38 && <span>{family.name}</span>}
                  </button>
                </Marker>
              )
            })}

          {countryDonuts
            .filter(
              (country) =>
                (zoom >= ZOOM_GLOBAL && zoom < ZOOM_COUNTRY) ||
                selectedCountry?.code === country.code ||
                (drawer?.kind === 'language' &&
                  country.observations.some((row) => row.languageId === drawer.languageId)),
            )
            .map((country) => {
              const isRelated =
                drawer?.kind === 'language' &&
                country.observations.some((row) => row.languageId === drawer.languageId)
              return (
                <Marker
                  key={country.code}
                  longitude={country.longitude}
                  latitude={country.latitude}
                  anchor="center"
                  offset={[18, -14]}
                >
                  <button
                    type="button"
                    className={`cldr-country-donut${selectedCountry?.code === country.code ? ' cldr-country-donut--selected' : ''}${isRelated ? ' cldr-country-donut--related' : ''}`}
                    style={{ background: donutBackground(country.observations) }}
                    aria-label={`${country.name}, ${country.observations.length} language records`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setDrawer({
                        kind: 'country',
                        code: country.code,
                        highlightLanguages: true,
                      })
                    }}
                  >
                    <span>{country.code}</span>
                  </button>
                </Marker>
              )
            })}

          {zoom >= ZOOM_COUNTRY &&
            languageOriginMarkers.map(({ id, name, longitude, latitude }) => (
              <Marker key={id} longitude={longitude} latitude={latitude} anchor="center">
                <span
                  className="cldr-language-origin-point"
                  title={`${name}: ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`}
                  role="img"
                  aria-label={`${name} origin at ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`}
                />
              </Marker>
            ))}

          <NavigationControl position="top-right" showCompass={false} />
          <ScaleControl position="bottom-right" unit="metric" />
        </MapView>

        <div className="cldr-map-controls">
          <AppSearch
            results={searchResults}
            query={query}
            setQuery={setQuery}
            onChoose={chooseSearchResult}
          />
          {(selectedLanguage || selectedCountry) && (
            <div className="cldr-geography-control">
              <label>
                <span>Language-area source</span>
                <select
                  value={geographySource}
                  onChange={(event) => setGeographySource(event.currentTarget.value)}
                >
                  <option value="all">Best available · all sources</option>
                  {atlas.datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.shortName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Time period</span>
                <select
                  value={geographyPeriod}
                  onChange={(event) => {
                    if (isTemporalViewSelection(event.currentTarget.value)) {
                      setGeographyPeriod(event.currentTarget.value)
                    }
                  }}
                >
                  {TEMPORAL_VIEWS.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.shortLabel}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                {selectedVariantIds.length} mapped area variants · {geographySourceLabel}
              </small>
            </div>
          )}
          {selectedCountry && (
            <>
              <fieldset className="cldr-metric-control">
                <legend>Country shading</legend>
                <button
                  type="button"
                  aria-pressed={metric === 'diversity'}
                  onClick={() => setMetric('diversity')}
                >
                  Language diversity
                </button>
                <button
                  type="button"
                  aria-pressed={metric === 'literacy'}
                  onClick={() => setMetric('literacy')}
                >
                  Literacy
                </button>
              </fieldset>
              <div className="cldr-map-legend" aria-live="polite">
                <strong>
                  {metric === 'diversity' ? 'Normalized language diversity' : 'Country literacy'}
                </strong>
                <span>
                  {metric === 'diversity' ? 'Low' : '0%'} <i aria-hidden="true" />
                  {metric === 'diversity' ? 'High' : '100%'}
                </span>
                <span className="cldr-map-legend__missing">
                  <i aria-hidden="true" /> No report
                </span>
              </div>
            </>
          )}
        </div>

        <div className="cldr-zoom-hint" aria-live="polite">
          {zoomHint}
        </div>
        {boundaryError && (
          <p className="cldr-map-error" role="alert">
            Country shading unavailable: {boundaryError}
          </p>
        )}
        {hatchingError?.drawer === drawer && (
          <p className="cldr-map-error" role="alert">
            Language overlap pattern unavailable: {hatchingError.message}
          </p>
        )}
      </div>

      <aside className="cldr-detail-panel" aria-label="Map details">
        <header className="cldr-detail-panel__header">
          <div>
            <p className="eyebrow">CLDR demographics</p>
            <h2>
              {selectedCountry?.name ??
                selectedLanguage?.languageName ??
                selectedFamily?.name ??
                'Explore map'}
            </h2>
          </div>
          {drawer && (
            <button
              type="button"
              className="cldr-detail-panel__close"
              aria-label="Clear map selection"
              onClick={() => setDrawer(null)}
            >
              ×
            </button>
          )}
        </header>

        {selectedLanguage ? (
          <LanguageDetail
            observation={selectedLanguage}
            rawVariants={selectedLanguageRawVariants}
          />
        ) : selectedCountry ? (
          <>
            <div className="cldr-detail__identity">
              <span className="cldr-detail__eyebrow">Territory · {selectedCountry.code}</span>
              <h2>{selectedCountry.name}</h2>
              <p>{selectedCountry.observations.length} mapped language records</p>
            </div>
            <div className="cldr-detail__pie">
              <div
                className="cldr-detail__pie-chart"
                role="img"
                aria-label={`Population share breakdown for ${selectedCountry.name}, by language official status`}
                style={{ background: donutBackground(selectedCountry.observations) }}
              >
                <span>{selectedCountry.observations.length}</span>
              </div>
              <p>
                Language share by official status
                <small>Segment sizes use reported population share</small>
              </p>
            </div>
            <dl className="cldr-detail__stats">
              <div>
                <dt>Reported speakers</dt>
                <dd>{selectedCountry.speakerCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Population</dt>
                <dd>
                  {selectedCountry.observations[0]?.territoryPopulation?.toLocaleString() ??
                    'Not available'}
                </dd>
              </div>
              <div>
                <dt>Territory literacy</dt>
                <dd>{formatPercent(selectedCountry.literacyPercent)}</dd>
              </div>
              <div>
                <dt>Language diversity index</dt>
                <dd>
                  {selectedCountry.diversityIndex === null
                    ? 'Not available'
                    : selectedCountry.diversityIndex.toFixed(2)}
                </dd>
              </div>
            </dl>
            <p className="cldr-detail__note">
              Language speaker estimates may overlap in multilingual populations, so their sum can
              exceed the territory population. CLDR script-code duplicates are collapsed by
              Glottocode, keeping the largest estimate.
            </p>
            <p className="cldr-detail__note">
              {drawer?.kind === 'country' && drawer.highlightLanguages
                ? 'Highlighted area outlines show the Glottolog origin areas of languages in this pie; they do not imply that speakers live at those origins.'
                : 'The highlighted border marks this territory. Select its pie chart on the map to highlight the Glottolog origin areas of its reported languages.'}
            </p>
            <div className="cldr-detail__language-list">
              <h3>Languages reported here</h3>
              {selectedCountryRows
                .slice()
                .sort((left, right) => (right.speakerCount ?? 0) - (left.speakerCount ?? 0))
                .slice(0, 10)
                .map((row) => (
                  <button
                    type="button"
                    key={row.languageId}
                    onClick={() =>
                      setDrawer({
                        kind: 'language',
                        languageId: row.languageId,
                        territoryCode: row.territoryCode,
                      })
                    }
                  >
                    <span>
                      <strong>{row.languageName}</strong>
                      <small>{row.languageId}</small>
                    </span>
                    <span>{formatCount(row.speakerCount ?? 0)}</span>
                  </button>
                ))}
            </div>
            <div className="cldr-status-legend">
              <span>
                <i style={{ background: OFFICIAL_COLORS.official }} />
                Official
              </span>
              <span>
                <i style={{ background: OFFICIAL_COLORS.official_regional }} />
                Regional official
              </span>
              <span>
                <i style={{ background: OFFICIAL_COLORS.de_facto_official }} />
                De facto official
              </span>
              <span>
                <i style={{ background: OFFICIAL_COLORS.unspecified }} />
                Unspecified / minority
              </span>
            </div>
          </>
        ) : selectedFamily ? (
          <>
            <div className="cldr-detail__identity">
              <span className="cldr-detail__eyebrow">Language family</span>
              <h2>{selectedFamily.name}</h2>
              <code>{selectedFamily.id}</code>
            </div>
            <dl className="cldr-detail__stats">
              <div>
                <dt>Languages represented</dt>
                <dd>{selectedFamily.languageCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Reported speakers across territories</dt>
                <dd>{selectedFamily.speakerCount.toLocaleString()}</dd>
              </div>
            </dl>
            <p className="cldr-detail__note">
              Family totals add the reported language estimates across territories; they are not a
              deduplicated census of unique people.
            </p>
            <div className="cldr-detail__language-list">
              <h3>Largest reported languages</h3>
              {[...(familyRows.get(selectedFamily.id) ?? [])]
                .sort((left, right) => (right.speakerCount ?? 0) - (left.speakerCount ?? 0))
                .slice(0, 10)
                .map((row) => (
                  <button
                    type="button"
                    key={`${row.languageId}:${row.territoryCode}`}
                    onClick={() =>
                      setDrawer({
                        kind: 'language',
                        languageId: row.languageId,
                        territoryCode: row.territoryCode,
                      })
                    }
                  >
                    <span>
                      <strong>{row.languageName}</strong>
                      <small>{countryNameFor(row.territoryCode)}</small>
                    </span>
                    <span>{formatCount(row.speakerCount ?? 0)}</span>
                  </button>
                ))}
            </div>
          </>
        ) : (
          <div className="cldr-detail__empty">
            <p>Search for a language, Glottocode, country or family, or select a map feature.</p>
          </div>
        )}

        {drawer && (
          <footer className="cldr-detail__footer">
            CLDR preprocessed language-territory estimates · pinned Glottolog IDs and origin
            coordinates
          </footer>
        )}
      </aside>
    </section>
  )
}
