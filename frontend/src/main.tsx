import { createRoot } from 'react-dom/client';
import { init } from 'ghostty-web';
import { App } from './App';
import { DEFAULT_THEME } from './state/defaultTheme';
import './fonts.css';
import '@fontsource/jetbrains-mono/100.css';
import '@fontsource/jetbrains-mono/200.css';
import '@fontsource/jetbrains-mono/300.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import '@fontsource/jetbrains-mono/100-italic.css';
import '@fontsource/jetbrains-mono/200-italic.css';
import '@fontsource/jetbrains-mono/300-italic.css';
import '@fontsource/jetbrains-mono/400-italic.css';
import '@fontsource/jetbrains-mono/500-italic.css';
import '@fontsource/jetbrains-mono/600-italic.css';
import '@fontsource/jetbrains-mono/700-italic.css';
import '@fontsource/jetbrains-mono/800-italic.css';
import '@fontsource/fira-code/300.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import '@fontsource/fira-code/600.css';
import '@fontsource/fira-code/700.css';
import '@fontsource/source-code-pro/200.css';
import '@fontsource/source-code-pro/300.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';
import '@fontsource/source-code-pro/600.css';
import '@fontsource/source-code-pro/700.css';
import '@fontsource/source-code-pro/800.css';
import '@fontsource/source-code-pro/900.css';
import '@fontsource/source-code-pro/200-italic.css';
import '@fontsource/source-code-pro/300-italic.css';
import '@fontsource/source-code-pro/400-italic.css';
import '@fontsource/source-code-pro/500-italic.css';
import '@fontsource/source-code-pro/600-italic.css';
import '@fontsource/source-code-pro/700-italic.css';
import '@fontsource/source-code-pro/800-italic.css';
import '@fontsource/source-code-pro/900-italic.css';
import '@fontsource/cascadia-code/200.css';
import '@fontsource/cascadia-code/300.css';
import '@fontsource/cascadia-code/400.css';
import '@fontsource/cascadia-code/500.css';
import '@fontsource/cascadia-code/600.css';
import '@fontsource/cascadia-code/700.css';
import '@fontsource/cascadia-code/200-italic.css';
import '@fontsource/cascadia-code/300-italic.css';
import '@fontsource/cascadia-code/400-italic.css';
import '@fontsource/cascadia-code/500-italic.css';
import '@fontsource/cascadia-code/600-italic.css';
import '@fontsource/cascadia-code/700-italic.css';

const cachedTheme = (() => {
  try {
    const s = localStorage.getItem('btmux-theme');
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
})();
document.body.style.background = cachedTheme?.background ?? DEFAULT_THEME.background;

async function main() {
  try {
    await init();
  } catch (e) {
    console.error('Failed to initialize ghostty-web:', e);
  }
  const root = createRoot(document.getElementById('root')!);
  root.render(<App />);
}

main();
