import type { AtlasData, GeographyDatasetId, TemporalViewSelection } from './atlas'

export interface CldrObservation {
  readonly territoryCode: string
  readonly territoryPopulation: number | null
  readonly territoryGdpUsd: number | null
  readonly territoryLiteracyPercent: number | null
  readonly populationPercent: number | null
  readonly speakerCount: number | null
  readonly officialStatus: string
  readonly iso6393: string | null
  readonly languageRawCode: string | null
  readonly languageId: string
  readonly languageName: string
  readonly glottologLevel: string
  readonly geometryLanguageId: string | null
  readonly familyId: string | null
  readonly macroareas: readonly string[]
  readonly latitude: number | null
  readonly longitude: number | null
}

export type CldrMetric = 'diversity' | 'literacy'
export type CldrGeographySelection = 'all' | GeographyDatasetId

export const canonicalCldrObservations = (
  observations: readonly CldrObservation[],
): CldrObservation[] => {
  const primaryByTerritoryAndLanguage = new Map<string, CldrObservation>()
  for (const observation of observations) {
    const key = `${observation.territoryCode}:${observation.languageId}`
    const previous = primaryByTerritoryAndLanguage.get(key)
    if (
      !previous ||
      (observation.speakerCount ?? 0) > (previous.speakerCount ?? 0) ||
      ((observation.speakerCount ?? 0) === (previous.speakerCount ?? 0) &&
        (observation.populationPercent ?? 0) > (previous.populationPercent ?? 0))
    ) {
      primaryByTerritoryAndLanguage.set(key, observation)
    }
  }
  return [...primaryByTerritoryAndLanguage.values()]
}

const geographySourcePriority = [
  'asher2007world',
  'wurm1981pacific',
  'matsumae2021exploring',
  'carling2025diacl',
  'bouckaert2012indoeuropean',
] as const
const geographySourceOrder: ReadonlyMap<string, number> = new Map(
  geographySourcePriority.map((sourceId, index) => [sourceId, index]),
)

export const cldrGeometryVariants = (
  data: AtlasData,
  observations: readonly CldrObservation[],
  source: CldrGeographySelection,
  period: TemporalViewSelection,
) => {
  const geometryLanguageIds = new Set(
    observations.flatMap((observation) =>
      observation.geometryLanguageId ? [observation.geometryLanguageId] : [],
    ),
  )
  const variants = new Map<string, string>()

  for (const languageId of geometryLanguageIds) {
    const language = data.languageById.get(languageId)
    if (!language) continue
    const candidates = language.geometryVariantIds
      .flatMap((variantId) => {
        const variant = data.variantById.get(variantId)
        if (!variant) return []
        if (source !== 'all' && variant.datasetId !== source) return []
        if (period !== 'all' && variant.temporalCoverage.viewId !== period) return []
        return [variant]
      })
      .sort((left, right) => {
        const leftPriority = geographySourceOrder.get(left.datasetId) ?? Number.MAX_SAFE_INTEGER
        const rightPriority = geographySourceOrder.get(right.datasetId) ?? Number.MAX_SAFE_INTEGER
        return leftPriority - rightPriority || left.sourceYear - right.sourceYear
      })
    const preferred = candidates[0]
    if (preferred) variants.set(languageId, preferred.id)
  }
  return variants
}
