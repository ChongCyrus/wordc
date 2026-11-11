import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './app/styles/global.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root 挂载点缺失，检查 index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
