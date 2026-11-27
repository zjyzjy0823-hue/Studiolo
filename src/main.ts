import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { isTauri } from '@tauri-apps/api/core'
import { installDesktopInteractions } from './desktop/desktopInteractions'
import { initializeDesktopPlatform } from './desktop/platform'
import { installTouchPressFeedback } from './utils/touchPressFeedback'
import { useFontScale } from './composables/useFontScale'
import App from './App.vue'
import './styles/main.css'
import './desktop/desktop.css'
import './styles/workbench.css'
import './styles/opus-app.css'
import './theme/tokens.css'

useFontScale()

async function mountApp() {
  const app = createApp(App).use(createPinia())
  app.onUnmount(installTouchPressFeedback())
  if (isTauri()) {
    const platform = await initializeDesktopPlatform()
    document.documentElement.classList.add(`studiolo-${platform}`)
    if (platform !== 'android') {
      document.documentElement.classList.add('studiolo-desktop')
      app.onUnmount(installDesktopInteractions(document, platform))
    }
  }
  app.mount('#app')
}
void mountApp()
