import type {
  AtlasData,
  AtlasManifest,
  GeographyDataset,
  GeometryVariant,
  Language,
} from '../domain/atlas'
import type { CldrObservation } from '../domain/cldr'

const dataUrl = (fileName: string) => `${import.meta.env.BASE_URL}data/${fileName}`

const fetchJson = async <T>(fileName: string): Promise<T> => {
  const response = await fetch(dataUrl(fileName))
  if (!response.ok) {
    throw new Error(`Could not load ${fileName}: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

const normalizeSearchText = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase()

let atlasDataPromise: Promise<AtlasData> | undefined

export const loadAtlasData = (): Promise<AtlasData> => {
  atlasDataPromise ??= Promise.all([
    fetchJson<AtlasManifest>('manifest.json'),
    fetchJson<readonly Language[]>('languages.json'),
    fetchJson<readonly GeometryVariant[]>('geometry-variants.json'),
    fetchJson<readonly GeographyDataset[]>('geography-datasets.json'),
  ]).then(([manifest, languages, variants, datasets]) => {
    if (manifest.schemaVersion !== 2) {
      throw new Error(`Unsupported atlas schema version: ${manifest.schemaVersion}`)
    }
    if (languages.length !== manifest.languageCount) {
      throw new Error('Language catalog does not match its manifest')
    }
    if (variants.length !== manifest.geometryVariantCount) {
      throw new Error('Geometry catalog does not match its manifest')
    }

    return {
      manifest,
      languages,
      variants,
      datasets,
      languageById: new Map(languages.map((language) => [language.id, language])),
      variantById: new Map(variants.map((variant) => [variant.id, variant])),
      searchTextByLanguageId: new Map(
        languages.map((language) => [
          language.id,
          normalizeSearchText(
            [language.name, language.id, language.iso6393, language.familyName]
              .filter(Boolean)
              .join(' '),
          ),
        ]),
      ),
    }
  })

  return atlasDataPromise
}

let cldrDataPromise: Promise<readonly CldrObservation[]> | undefined

export const loadCldrData = (): Promise<readonly CldrObservation[]> => {
  cldrDataPromise ??= fetchJson<readonly CldrObservation[]>('cldr-language-demographics.json')
  return cldrDataPromise
}

export const normalizeLanguageQuery = normalizeSearchText

export const languageArchiveUrl = () => {
  const archiveUrl = new URL(dataUrl('language-areas.pmtiles'), window.location.href)
  return `pmtiles://${archiveUrl.href}`
}
