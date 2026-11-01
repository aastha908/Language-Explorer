import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AtlasData, GeometryVariant, Language } from '../src/domain/atlas.ts'
import {
  type CldrObservation,
  canonicalCldrObservations,
  cldrGeometryVariants,
} from '../src/domain/cldr.ts'

const observation = (
  territoryCode: string,
  speakerCount: number,
  languageRawCode: string,
): CldrObservation => ({
  territoryCode,
  territoryPopulation: 1_000_000_000,
  territoryGdpUsd: null,
  territoryLiteracyPercent: null,
  populationPercent: speakerCount / 10_000_000,
  speakerCount,
  officialStatus: 'unspecified',
  iso6393: 'hin',
  languageRawCode,
  languageId: 'hind1269',
  languageName: 'Hindi',
  glottologLevel: 'language',
  geometryLanguageId: 'hind1269',
  familyId: 'indo1319',
  macroareas: ['Eurasia'],
  latitude: 22,
  longitude: 78,
})

const variant = (
  id: string,
  datasetId: string,
  viewId: 'contemporary' | 'year-1750',
): GeometryVariant => ({
  id,
  languageId: 'hind1269',
  datasetId,
  layer: viewId === 'year-1750' ? 'snapshot' : 'contemporary',
  label: id,
  featureId: 1,
  color: '#000000',
  temporalCoverage:
    viewId === 'year-1750'
      ? {
          kind: 'snapshot',
          viewId,
          label: 'Approximately 1750',
          quality: 'approximate',
          year: 1750,
        }
      : {
          kind: 'named-period',
          viewId,
          label: 'Contemporary',
          quality: 'approximate',
        },
  sourceYear: 2007,
})

const atlasFixture = (): AtlasData => {
  const language: Language = {
    id: 'hind1269',
    name: 'Hindi',
    iso6393: 'hin',
    familyId: 'indo1319',
    familyName: 'Indo-European',
    macroarea: 'Eurasia',
    countries: ['IN'],
    latitude: 22,
    longitude: 78,
    geometryVariantIds: ['wurm', 'asher', 'diacl'],
  }
  const variants = [
    variant('wurm', 'wurm1981pacific', 'contemporary'),
    variant('asher', 'asher2007world', 'contemporary'),
    variant('diacl', 'carling2025diacl', 'year-1750'),
  ]
  return {
    manifest: {
      schemaVersion: 2,
      languageCount: 1,
      languageWithGeometryCount: 1,
      geometryVariantCount: variants.length,
      vectorLayer: 'language_areas',
      archive: 'language-areas.pmtiles',
    },
    languages: [language],
    variants,
    datasets: [],
    languageById: new Map([[language.id, language]]),
    variantById: new Map(variants.map((item) => [item.id, item])),
    searchTextByLanguageId: new Map(),
  }
}

test('canonical CLDR rows keep the largest script-code estimate per territory and Glottocode', () => {
  const observations = [
    observation('IN', 2_000_000, 'hi_Latn'),
    observation('IN', 577_700_000, 'hi'),
    observation('NP', 1_000_000, 'hi'),
  ]

  const canonical = canonicalCldrObservations(observations)

  assert.equal(canonical.length, 2)
  assert.equal(canonical.find((row) => row.territoryCode === 'IN')?.speakerCount, 577_700_000)
  assert.equal(canonical.find((row) => row.territoryCode === 'IN')?.languageRawCode, 'hi')
})

test('CLDR geometry selection honors requested source and period, with deterministic all-source fallback', () => {
  const atlas = atlasFixture()
  const observations = [observation('IN', 577_700_000, 'hi')]

  assert.equal(
    cldrGeometryVariants(atlas, observations, 'all', 'contemporary').get('hind1269'),
    'asher',
  )
  assert.equal(
    cldrGeometryVariants(atlas, observations, 'carling2025diacl', 'year-1750').get('hind1269'),
    'diacl',
  )
  assert.equal(
    cldrGeometryVariants(atlas, observations, 'wurm1981pacific', 'contemporary').get('hind1269'),
    'wurm',
  )
})
