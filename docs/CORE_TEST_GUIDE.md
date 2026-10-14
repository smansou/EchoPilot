# Core end-to-end test

Test with a disposable project and non-sensitive text. The [locally qualified app](</Users/sobhi/Documents/ChatGPT/EchoPilot/.worktrees/complete-app/artifacts/local-app/EchoPilot-0.1.0-2026-10-02-011817Z-e051f0.app>) passed packaged smoke and voice lifecycle checks ([qualification report](</Users/sobhi/Documents/ChatGPT/EchoPilot/.worktrees/complete-app/artifacts/local-app/EchoPilot-0.1.0-2026-10-02-011817Z-e051f0.app.qualification.json>)). It has an ad-hoc local signature and is not notarized or distributable. These steps do not qualify paid-provider behavior or hardware quality.

## Set up

1. Open EchoPilot and Mission Control. In **Work**, click **Choose project** and associate a throwaway project folder. Grant macOS **Microphone** permission when prompted. Dictation's **Context-aware dictation** also needs Accessibility access; allow it in macOS Privacy & Security if that flow requests it.
2. If testing provider-backed answers, go to **Providers** → **OpenAI API key**, enter the key in the app, then click **Store securely**. Never paste a key in chat, a terminal, or this guide. Key storage alone sends nothing.

## Dictate and safely insert

3. Focus a scratch document in TextEdit. Press **Control+Option+Space** once to start dictation; speak a short sentence; press the same shortcut again to stop and prepare the draft. This is a toggle, not a press-and-hold shortcut. Check the draft in **Dictation**. Nothing is inserted automatically. Dictation captures retain up to 16,384 UTF-8 bytes, and the full capture stays available for review even when the coordinator's display preview is shorter; if the whole transcript does not fit the correction context budget, **Review correction context** says so, keeps the complete raw text unchanged, and sends nothing to OpenAI.
4. With TextEdit still focused, use the floating widget's **Preview prepared draft**. Read the target and text preview. Click **Confirm insertion** only if both are correct; otherwise click **Cancel**. Verify the text was appended and no Return was sent. Then click **Undo preview**, inspect the restore preview, and use **Confirm restore** to undo the test insertion.

## Check project memory and review

5. In **Memory** → **Notes and source corrections**, enter two harmless notes whose text explicitly identifies a fact from today and one from yesterday. Click **Review memory change**, inspect it, then click **Confirm save to encrypted memory**. Restart EchoPilot, reopen the same project, and verify both notes remain in its timeline. On **Voice** → **Ask your project memory**, type a question asking for both dated facts. Click **Review evidence**, inspect the question and evidence, then click **Confirm answer request** only if you want that reviewed text and evidence sent to OpenAI. After the answer appears, restart and ask what you asked and what answer you received to check paired dialogue recall. A confirmed answer should cite source ids when available; treat it as a summary, not automatic verification.
6. The optional **Enable hands-free answers for 5 minutes** mode is separate consent: recognized question text and bounded project memory/history may go to OpenAI, for up to 5 minutes or 10 requests; microphone audio stays local. It is off unless enabled. Premium voice is a separate reviewed-text-only path; microphone audio upload is unavailable there.

## Scope and privacy

7. While a review is pending, change the selected project in **Work** or enable Private mode in **Privacy**. The old review should clear or refuse confirmation; do not retry it across scopes. Check that project memory is scoped to the selected project. Restart and verify the same project's saved timeline remains.

If a permission or helper is unavailable, stop at the preview stage and note the exact status shown in Mission Control or the widget. A successful local smoke test does not prove provider billing, production microphone quality, or clean-machine installation.

## Optional local VS Code selection connector

This connector shares one explicitly selected excerpt to EchoPilot locally; it does not edit the editor or send the excerpt to a model.

1. If you want to try it, install the [echopilot-selection 0.1.0 VSIX](</Users/sobhi/Documents/ChatGPT/EchoPilot/.worktrees/complete-app/artifacts/vscode/echopilot-selection-0.1.0.vsix>) yourself with VS Code's local VSIX installation flow. Open the same canonical project folder in VS Code and select it in EchoPilot **Work**.
2. In Mission Control **Desktop** → **VS Code selection connector**, click **Enable temporary local connection**. In VS Code, run **EchoPilot: Pair Local Selection Connector** and paste the pairing JSON into its input. The pairing expires after five minutes.
3. Select a small, non-sensitive excerpt (maximum 16 KiB) in a file under that workspace. Run **EchoPilot: Review and Share Selection**, inspect the modal, and choose **Share selection** only if the excerpt is correct.
4. In EchoPilot, click **Refresh shared selection** and check the excerpt. It is labelled untrusted editor text and expires after 30 seconds. Click **Disconnect and clear selection** when finished.
