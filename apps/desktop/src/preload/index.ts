import { contextBridge, ipcRenderer } from 'electron';
import { parseCommand, parseState, type Command, type State } from '../../../../packages/contracts/src/index';
contextBridge.exposeInMainWorld('echo', Object.freeze({
  command: async (command: Command): Promise<State> => parseState(await ipcRenderer.invoke('echo:command', parseCommand(command))),
  onState: (listener: (state: State) => void): (() => void) => {
    const handler = (_event: unknown, value: unknown) => listener(parseState(value));
    ipcRenderer.on('echo:state', handler);
    return () => { ipcRenderer.removeListener('echo:state', handler); };
  },
}));
