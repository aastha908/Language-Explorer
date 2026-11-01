import { Suspense, useState } from 'react'
import { CldrMapView } from './features/cldr/CldrMapView.tsx'
import { LanguageFinder, LanguageFinderFallback } from './features/languages/LanguageFinder.tsx'
import { WorldMap } from './features/map/WorldMap.tsx'

export const App = () => {
  const [activeView, setActiveView] = useState<'atlas' | 'cldr'>('atlas')
  const [hasOpenedCldr, setHasOpenedCldr] = useState(false)

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Interactive atlas</p>
          <h1>Languages of the world</h1>
        </div>
        <p className="app-summary">Explore where languages are spoken and how they relate.</p>
      </header>

      <div className="view-tabs" role="tablist" aria-label="Atlas views">
        <button
          type="button"
          role="tab"
          id="atlas-tab"
          aria-selected={activeView === 'atlas'}
          aria-controls="atlas-panel"
          onClick={() => setActiveView('atlas')}
        >
          Language areas
        </button>
        <button
          type="button"
          role="tab"
          id="cldr-tab"
          aria-selected={activeView === 'cldr'}
          aria-controls="cldr-panel"
          onClick={() => {
            setHasOpenedCldr(true)
            setActiveView('cldr')
          }}
        >
          CLDR demographics
        </button>
      </div>

      <main
        className="atlas-workspace"
        role="tabpanel"
        id="atlas-panel"
        aria-labelledby="atlas-tab"
        hidden={activeView !== 'atlas'}
      >
        <section className="map-shell" aria-label="Language map">
          <WorldMap />
        </section>
        <Suspense fallback={<LanguageFinderFallback />}>
          <LanguageFinder />
        </Suspense>
      </main>
      {hasOpenedCldr && (
        <main
          className="cldr-panel"
          role="tabpanel"
          id="cldr-panel"
          aria-labelledby="cldr-tab"
          hidden={activeView !== 'cldr'}
        >
          <Suspense fallback={<div className="cldr-loading">Loading CLDR demographics…</div>}>
            <CldrMapView />
          </Suspense>
        </main>
      )}
    </div>
  )
}
