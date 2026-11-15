// Published builds contain no sample server, client or metric fixtures.
import type { Server } from '../../shared/types';
import type { DemoData, demoSamples as SampleType } from './demo';
export const demoServers: Server[] = [];
export const demoStatus = null;
export const demoSamples: typeof SampleType = [];
export function newDemoData(): DemoData { return { inbounds: [], xray: {}, settings: {} }; }
export function runDemo(): never { throw new Error('Sample data is unavailable in the published panel.'); }
