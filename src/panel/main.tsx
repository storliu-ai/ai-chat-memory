import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const surface = new URLSearchParams(location.search).get('surface') === 'overlay'
  ? 'overlay'
  : 'manager'
document.documentElement.dataset.surface = surface

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Floating panel root element is missing')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
