import { Topbar, StaleBanner } from './components/Topbar'
import { LeftRail } from './components/LeftRail'
import { ChartPanel } from './components/ChartPanel'
import { RightRail } from './components/RightRail'
import { ExplainCard } from './components/Explain'

export function App() {
  return (
    <div className="app">
      <Topbar />
      <StaleBanner />
      <main className="layout">
        <LeftRail />
        <ChartPanel />
        <RightRail />
      </main>
      <div className="layout" style={{ gridTemplateColumns: 'minmax(0, 1fr)', paddingTop: 0 }}>
        <ExplainCard />
      </div>
    </div>
  )
}
