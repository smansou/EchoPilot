# EchoPilot VS Code selection connector

This runnable extension shares only text explicitly selected and confirmed in a trusted local
workspace. It does not edit documents, watch editor changes, save tokens, log selection text, or
contact a model. Browser automation and editor writes are not implemented.

Activation is a user step. For a development installation, open this extension directory in a
VS Code Extension Development Host using the official extension debugging workflow. Alternatively
package it with the standard VS Code extension tooling and install the resulting VSIX yourself.
EchoPilot does not install it or grant permissions for you.

1. Select the same canonical project root in EchoPilot and VS Code.
2. In EchoPilot's VS Code connector controls, enable the temporary connection.
3. Run **EchoPilot: Pair Local Selection Connector** in VS Code and paste the pairing JSON.
4. Select at most 16 KiB and run **EchoPilot: Review and Share Selection**. Confirm the exact
   excerpt in VS Code's modal. Changes to document revision or selection cancel sharing.
5. Refresh shared selection in EchoPilot. The excerpt expires after 30 seconds. Pairing expires
   after five minutes. Disconnect or a project/privacy transition revokes the listener and cache.

Transport is authenticated HTTP bound to 127.0.0.1 only. Browser Origin headers, wrong Host,
foreign projects, escaped/symlinked documents, extra commands, missing confirmation, expired tokens,
and oversized payloads are refused. The pairing secret authorizes only local selected-text reads.
The receiver treats selection contents as untrusted data, never instructions. A token holder can
claim a revision; revision authenticity is supplied by the installed extension, not independently
verified by the receiver. No editor writing capability is exposed.

Official API references: [TextDocument and TextEditor](https://code.visualstudio.com/api/references/vscode-api),
[extension debugging](https://code.visualstudio.com/api/get-started/your-first-extension),
[workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust).
