import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initializeLocale } from './lib/i18n';
import './styles.css';
import './team-lab.css';
void initializeLocale().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
});

import './locale.css';
import './login.css';

import './launch.css';
