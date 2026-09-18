import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './style.css';
import { locale, t } from './i18n.js';

document.documentElement.lang = locale;
document.title = `cmdr · ${t('小队看板')}`;

createRoot(document.getElementById('root')!).render(<App />);
