export type TextProvider='openai'|'openrouter'|'gemini'|'anthropic';
export type VoiceProvider='openai'|'gemini';
export const PROVIDER_LABELS:Record<TextProvider,string>={openai:'OpenAI',openrouter:'OpenRouter',gemini:'Gemini',anthropic:'Anthropic'};
export const DEFAULT_MODELS:Record<TextProvider,string>={openai:'gpt-4.1-mini',openrouter:'openai/gpt-4.1-mini',gemini:'gemini-3.5-flash-lite',anthropic:'claude-haiku-5-5'};
export type SetupPreset='gemini'|'openai'|'custom';
/** Product configuration is independent of each provider's voice protocol. */
export function resolveProviderSetup(setting:(key:string)=>string){
  const preset=setting('setup.preset')||'gemini';
  const voice:VoiceProvider=preset==='custom'?(setting('live.provider')==='openai'?'openai':'gemini'):preset==='openai'?'openai':'gemini';
  const configured=setting('providers.active');
  const reasoning:TextProvider=preset==='custom'&&['openai','openrouter','gemini','anthropic'].includes(configured)?configured as TextProvider:voice;
  const key=reasoning==='anthropic'?'providers.anthropicModel':reasoning==='openai'?'providers.textModel':reasoning==='gemini'?'providers.geminiModel':'providers.openrouterModel';
  return {preset,voice,reasoning,textModel:preset==='custom'?(setting(key)||DEFAULT_MODELS[reasoning]):(setting(voice==='openai'?'providers.openaiSelectedModel':'providers.geminiSelectedModel')||DEFAULT_MODELS[reasoning]),speechModel:reasoning==='openrouter'?'openai/whisper-large-v3-turbo':reasoning==='gemini'?DEFAULT_MODELS.gemini:'gpt-4o-mini-transcribe',voiceName:voice==='gemini'?(setting('live.geminiVoice')||'Kore'):(setting('live.openaiVoice')||'marin')};
}
