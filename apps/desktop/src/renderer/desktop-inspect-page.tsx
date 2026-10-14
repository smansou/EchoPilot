/**
 * Mission Control's Desktop page (C05): read-only documentation of the widget's one-click window
 * inspection, the packaged helper's readiness, and the explicit list of what is not connected.
 *
 * It never claims OCR, desktop actions, or intelligent C01 answers are available, and it states
 * that the grounded question panel below only ever sends after the exact prompt was reviewed. In
 * the widget that action is a single bounded Accessibility read; this page explains that and
 * points the user at Work, where selecting a managed session also selects the project the widget
 * inspects.
 */
import { Readiness, SectionHeading } from './signal-ui';

export type DesktopObserveStatus = Readonly<{
  helperFound: boolean;
  helperPath: string | null;
  searched: readonly string[];
}>;

export function DesktopInspectPage({ observe, onOpenWork }: {
  observe: DesktopObserveStatus | null;
  onOpenWork: () => void;
}) {
  return <>
    <SectionHeading eyebrow="DESKTOP CONTEXT" title="Understand what is in front of you." description="One read-only Accessibility inspection of the focused window, on demand, inside the project scope you chose in Work." />
    <section className="signal-card" aria-label="Read-only window inspection">
      <div className="signal-card-head"><div><h2>Read-only window inspection</h2><p>In the widget, choose "Inspect window". It reads the focused window once, then stops — no background capture and no polling of foreground content.</p></div><Readiness ready={observe?.helperFound ?? false}>{observe === null ? 'Checking helper' : observe.helperFound ? 'Helper ready' : 'Helper missing'}</Readiness></div>
      <p className="signal-muted">The result appears in the widget as a bounded local preview of real Accessibility labels and values with evidence ids, labelled "local Accessibility preview — no AI answer or screenshot". It is never spoken, never stored, and never sent to an API.</p>
      <p className="signal-feedback" role="status">{observe === null ? 'Checking whether the packaged observation helper is present…' : observe.helperFound ? `The packaged observation helper is present${observe.helperPath ? ` at ${observe.helperPath}` : ''}. Inspecting still requires macOS Accessibility access and an active Work project.` : 'The packaged observation helper is missing from this build. Run pnpm dev to build and sign dist/native/echopilot-desktop, then reopen Mission Control.'}{observe !== null && !observe.helperFound && observe.searched.length > 0 ? ` Searched: ${observe.searched.join(', ')}` : ''}</p>
    </section>
    <section className="signal-card">
<div className="signal-card-head"><div><h2>Scope comes from Work</h2><p>Selecting a managed session tab in Work also selects that project for the widget. Exactly one active project is used automatically; several active projects show a choose-one instruction instead of guessing.</p></div><button className="text-button" onClick={onOpenWork}>Open Work ↗</button></div>
      <p className="signal-muted" role="status">Not connected in this build: OCR, desktop actions, and intelligent C01 answers. Asking a grounded question about the latest snapshot happens in the "Ask about the latest snapshot" card below — inspecting, opening, and previewing never send, and the exact prompt is always reviewed before any send.</p>
    </section>
  </>;
}
