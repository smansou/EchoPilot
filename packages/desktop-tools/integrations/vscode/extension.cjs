const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs/promises');
let session = null;
let generation = 0;
let active = null;
function disconnect() {generation++; session = null; active?.destroy(); active = null;}
function pairing(value) {
  const data = JSON.parse(value);
  const url = new URL(data.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/selection' || url.search || url.hash || url.username || url.password || !/^[a-f0-9]{64}$/.test(data.token) || typeof data.root !== 'string' || typeof data.projectId !== 'string' || !Number.isSafeInteger(data.expiresAt) || Date.now() >= data.expiresAt) throw Error('Invalid or expired local pairing.');
  return data;
}
function send(data, body) {
  return new Promise((resolve, reject) => {
    const bytes = JSON.stringify(body);
    const request = http.request(data.endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${data.token}`, 'Content-Length': Buffer.byteLength(bytes)}, timeout: 6000}, response => {
      response.resume(); response.once('end', () => response.statusCode === 200 ? resolve() : reject(Error('EchoPilot refused the selection. Pair again if the project or privacy mode changed.')));
    });
    active = request;
    request.once('timeout', () => request.destroy(Error('Connector timed out.')));
    request.once('error', reject); request.once('close', () => {if (active === request) active = null;}); request.end(bytes);
  });
}
function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('echopilot.pair', async () => {
    try {
      disconnect();
      const started = generation;
      if (!vscode.workspace.isTrusted) throw Error('A trusted local workspace is required.');
      const input = await vscode.window.showInputBox({prompt: 'Paste the temporary pairing JSON shown by EchoPilot for this project.', password: true, ignoreFocusOut: true});
      if (!input) return;
      const data = pairing(input);
      const roots = await Promise.all((vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => fs.realpath(folder.uri.fsPath)));
      if (!roots.includes(data.root)) throw Error('The paired project must match a local workspace folder exactly.');
      if (generation !== started) return;
      session = data;
      void vscode.window.showInformationMessage('EchoPilot paired for five minutes. Nothing is shared until Review and Share Selection.');
    } catch (error) {void vscode.window.showErrorMessage(error.message);}
  }), vscode.commands.registerCommand('echopilot.disconnect', disconnect), vscode.commands.registerCommand('echopilot.shareSelection', async () => {
    try {
      const data = session; const started = generation; const editor = vscode.window.activeTextEditor;
      if (!data || Date.now() >= data.expiresAt || !editor || editor.document.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw Error('Pair a trusted local workspace and select editor text first.');
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!folder || await fs.realpath(folder.uri.fsPath) !== data.root) throw Error('The active editor belongs to another project.');
      const document = editor.document; const version = document.version; const selection = editor.selection; const text = document.getText(selection);
      if (!text.trim() || Buffer.byteLength(text) > 16384) throw Error('Select nonempty text up to 16 KiB.');
      const confirmed = await vscode.window.showInformationMessage(`Share this selection locally with EchoPilot?\n${text}`, {modal: true}, 'Share selection');
      if (confirmed !== 'Share selection') return;
      if (generation !== started || session !== data || document.version !== version || vscode.window.activeTextEditor !== editor || !editor.selection.isEqual(selection) || Date.now() >= data.expiresAt) throw Error('Selection or connection changed. Review again.');
      await send(data, {command: 'share-selection', projectId: data.projectId, root: data.root, document: document.uri.fsPath, version, selection: text, language: document.languageId, confirmed: true});
      void vscode.window.showInformationMessage('Selection shared locally for 30 seconds. It was not sent to a model.');
    } catch (error) {void vscode.window.showErrorMessage(error.message);}
  }), {dispose: disconnect});
}
module.exports = {activate, deactivate: disconnect};
