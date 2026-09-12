import { contextBridge, ipcRenderer } from 'electron';
import { parseCommand, parseState, type Command, type State } from '../../../../packages/contracts/src/index';
import {
  KEY_ENTRY_CHANNEL,
  parseKeyEntryRequest,
  parseKeyEntryResult,
  type KeyEntryResult,
} from '../../../../packages/security/src/channels';
contextBridge.exposeInMainWorld('echo', Object.freeze({
  command: async (command: Command): Promise<State> => parseState(await ipcRenderer.invoke('echo:command', parseCommand(command))),
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
}));
