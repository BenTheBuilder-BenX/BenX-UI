import { Component, type ReactNode } from 'react';
import { t } from '../lib/i18n';
import { Button, Notice } from './ui';

/** Keep navigation usable if one page cannot render unexpected remote data. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <Notice tone="error">{t('This page could not be displayed. You can open another section or retry.')} <Button onClick={() => this.setState({ failed: false })}>{t('Retry')}</Button> <Button onClick={() => location.reload()}>{t('Reload panel')}</Button></Notice>;
    return this.props.children;
  }
}
