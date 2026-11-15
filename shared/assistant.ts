import type { JsonObject } from './types';
export type AIProvider = 'gemini' | 'openai';
export interface AISettings { provider: AIProvider; model: string; hasKey: boolean }
export interface AIAction { type: 'create-client' | 'create-inbound' | 'attach-client'; title: string; payload: JsonObject }
export interface AIReply { answer: string; actions: AIAction[]; draftId?: string; serverId?: string; expectedRevision?: number }
export const aiProviders = {
  gemini: { name: 'Google Gemini', model: 'gemini-3.5-flash-lite', keys: 'https://aistudio.google.com/apikey', guide: 'https://ai.google.dev/gemini-api/docs/api-key', pricing: 'https://ai.google.dev/gemini-api/docs/pricing' },
  openai: { name: 'OpenAI', model: 'gpt-6-luna', keys: 'https://platform.openai.com/api-keys', guide: 'https://developers.openai.com/api/docs/quickstart', pricing: 'https://developers.openai.com/api/docs/pricing' },
} as const;
export const aiModels = {
  gemini: [{ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite · economical', cost: 'Free tier available; paid $0.30 input / $2.50 output per million tokens.' }, { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · newest Flash', cost: 'Free tier available; paid $0.75 / $3.75 promotional through December 2026.' }],
  openai: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna · economical', cost: '$0.10 input / $0.50 output per million tokens; API billing required.' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol · more capable', cost: '$2 input / $10 output per million tokens; API billing required.' }],
};
export function currentAIModel(provider: AIProvider, model: string) {
  return model === (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1-mini') ? aiProviders[provider].model : model;
}
