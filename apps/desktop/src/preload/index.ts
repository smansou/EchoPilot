import { contextBridge, ipcRenderer } from 'electron';
import { parseCommand, parseState, type Command, type State } from '../../../../packages/contracts/src/index';
import {
  KEY_ENTRY_CHANNEL,
  parseKeyEntryRequest,
  parseKeyEntryResult,
  type KeyEntryResult,
} from '../../../../packages/security/src/channels';
contextBridge.exposeInMainWorld('echo', Object.freeze({
  desktop: (input: Record<string, unknown>) => ipcRenderer.invoke('echo:desktop', input),
  onLiveMedia: (listener: (event: {sessionId:string;type:'audio'|'interrupt';pcmBase64?:string;sampleRate?:24000}) => void) => {
    const handler=(_event:unknown,value:any)=>{if(!value||typeof value.sessionId!=='string'||value.sessionId.length>100)return;if(value.type==='interrupt')listener({sessionId:value.sessionId,type:'interrupt'});else if(value.type==='audio'&&value.sampleRate===24000&&typeof value.pcmBase64==='string'&&value.pcmBase64.length<=192000&&/^[A-Za-z0-9+/]*={0,2}$/.test(value.pcmBase64))listener({sessionId:value.sessionId,type:'audio',pcmBase64:value.pcmBase64,sampleRate:24000});};
    ipcRenderer.on('echo:live-media',handler);return ()=>ipcRenderer.removeListener('echo:live-media',handler);
  },
  onGazeOverlay: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('echo:gaze-overlay', handler);
    return () => ipcRenderer.removeListener('echo:gaze-overlay', handler);
  },
  command: async (command: Command): Promise<State> => parseState(await ipcRenderer.invoke('echo:command', parseCommand(command))),
  claimSpeech: async (): Promise<boolean> => (await ipcRenderer.invoke('echo:claim-speech')) === true,
  /**
   * Provider keys use their own channel: they are validated here, forwarded once, and the renderer
   * receives a redacted reference only. `echo:command` never carries a secret.
   */
  keyEntry: async (input: { provider: string; secret: string }): Promise<KeyEntryResult> => {
    const request = parseKeyEntryRequest(input);
    const result = parseKeyEntryResult(await ipcRenderer.invoke(KEY_ENTRY_CHANNEL, request), request.secret);
    return result;
  },
  onState: (listener: (state: State) => void): (() => void) => {
    const handler = (_event: unknown, value: unknown) => listener(parseState(value));
    ipcRenderer.on('echo:state', handler);
    return () => { ipcRenderer.removeListener('echo:state', handler); };
  },
  onSystemSpeech: (listener: (plan: { id: string; eventId: string; text: string }) => void): (() => void) => {
    const handler = (_event: unknown, value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      const plan = value as Record<string, unknown>;
      if (typeof plan.id !== 'string' || typeof plan.eventId !== 'string'
        || typeof plan.text !== 'string' || plan.text.length === 0 || plan.text.length > 500) return;
      listener({ id: plan.id, eventId: plan.eventId, text: plan.text });
    };
    ipcRenderer.on('echo:system-speech', handler);
    return () => { ipcRenderer.removeListener('echo:system-speech', handler); };
  },
  onStopSpeech: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on('echo:stop-speech', handler);
    return () => { ipcRenderer.removeListener('echo:stop-speech', handler); };
  },
  onPrivacyCleared: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on('echo:privacy-cleared', handler);
    return () => { ipcRenderer.removeListener('echo:privacy-cleared', handler); };
  },
}));

// Sensitive profile operations use their own trusted channel. Passphrases are forwarded once and
// never enter the general command/state stream or a renderer-side persistence API.
contextBridge.exposeInMainWorld('echoPrivacy', Object.freeze({
  forget: (selection: { eventIds?: readonly string[] }) =>
    ipcRenderer.invoke('echo:privacy', { action: 'forget', eventIds: selection.eventIds ?? [] }),
  exportProfile: (request: { passphrase: string }) =>
    ipcRenderer.invoke('echo:privacy', { action: 'export', passphrase: request.passphrase }),
  importProfile: (request: { archive: string; passphrase: string }) =>
    ipcRenderer.invoke('echo:privacy', { action: 'import', archive: request.archive, passphrase: request.passphrase }),
  beginPrivateSession: (request: { sessionId: string }) =>
    ipcRenderer.invoke('echo:privacy', { action: 'begin', sessionId: request.sessionId }),
  endPrivateSession: (request: { sessionId: string }) =>
    ipcRenderer.invoke('echo:privacy', { action: 'end', sessionId: request.sessionId }),
}));
