import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { registerServiceWorker } from './sw-client.ts';
import { installDebugHooks } from './debug.ts';

createRoot(document.getElementById('root')!).render(<App />);
registerServiceWorker();
installDebugHooks();
