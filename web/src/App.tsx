import { lazy, Suspense, useEffect } from 'react'
import { Shell } from './components/Shell'
import { GameProvider } from './game/context'
import { match, usePath } from './lib/router'
import { Lobby } from './screens/Lobby'

const Landing = lazy(() => import('./screens/Landing').then((m) => ({ default: m.Landing })))
const Enter = lazy(() => import('./screens/Enter').then((m) => ({ default: m.Enter })))
const Corner = lazy(() => import('./screens/Corner').then((m) => ({ default: m.Corner })))
const Bout = lazy(() => import('./screens/Bout').then((m) => ({ default: m.Bout })))
const Book = lazy(() => import('./screens/Book').then((m) => ({ default: m.Book })))
const How = lazy(() => import('./screens/How').then((m) => ({ default: m.How })))
const Promoter = lazy(() => import('./screens/Promoter').then((m) => ({ default: m.Promoter })))
const Legal = lazy(() => import('./screens/Legal').then((m) => ({ default: m.Legal })))

function Routes() {
  const path = usePath()
  useEffect(() => { document.documentElement.dataset.route = path.split('/')[1] || 'home' }, [path])
  if (path === '/') return <Landing />
  if (path === '/enter') return <Enter />
  if (path === '/terms' || path === '/privacy') return <Legal kind={path.slice(1) as 'terms' | 'privacy'} />
  const belt = match('/play/belt/:id', path)
  const bout = match('/play/bout/:id', path)
  let screen
  if (path === '/play' || path === '/play/') screen = <Lobby />
  else if (belt) screen = <Corner beltId={belt.id} />
  else if (bout) return <Shell bare><Bout beltId={bout.id} /></Shell>
  else if (path === '/play/book') screen = <Book />
  else if (path === '/play/how') screen = <How />
  else if (path === '/play/promoter') screen = <Promoter />
  else screen = <NotFound />
  return <Shell>{screen}</Shell>
}

function NotFound() {
  return (
    <div className="page"><div className="state-box"><span className="serif-i">Wrong arena.</span><a className="btn btn-ghost btn-sm" href="/play">Back to the belts</a></div></div>
  )
}

export default function App() {
  return (
    <GameProvider>
      <div className="grain">
        <Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 320 }} /></div>}>
          <Routes />
        </Suspense>
      </div>
    </GameProvider>
  )
}
