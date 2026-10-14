/**
 * The visible side of the C05 widget inspect flow: busy is handled by the widget, and every
 * finished state here paints exactly what the route reported — a bounded preview of real AX text
 * with preview evidence ids, a named denial, the choose-a-project instruction, or a named failure.
 * Nothing is upgraded, spoken, or filled in.
 */
import type { DesktopEvidencePreview, DesktopInspectState } from './desktop-inspect';
import { DESKTOP_DENIAL_COPY, DESKTOP_PREVIEW_LABEL } from './desktop-inspect';

function PreviewPanel({ preview, projectLabel }: { preview: DesktopEvidencePreview; projectLabel: string }) {
  const partial = preview.quality === 'partial' || preview.truncated;
  const bounds = preview.truncations.length > 0 ? preview.truncations.join(', ') : 'an unreported bound';
  return (
    <section className="desktop-inspect-preview" aria-label="Local Accessibility preview">
      <p className="desktop-inspect-scope-line">Project: {projectLabel}</p>
      <dl className="desktop-inspect-identity">
        <div>
          <dt>Application</dt>
          <dd>
            {preview.application.name} — {preview.application.bundleId} (pid {preview.application.pid})
            {preview.application.identityTruncated ? ' · identity truncated' : ''}
          </dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>
            {preview.window.title.trim().length > 0 ? preview.window.title : '(untitled)'} — {preview.window.role}
            {preview.window.titleTruncated ? ' · title truncated' : ''}
          </dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>{partial ? 'Partial snapshot' : 'Complete bounded snapshot'} · {preview.emittedNodes} of {preview.visitedNodes} nodes kept</dd>
        </div>
        <div>
          <dt>Speech</dt>
          <dd data-state="visible">Off — this preview is never spoken</dd>
        </div>
      </dl>
      {partial && (
        <p className="desktop-inspect-partial" role="status">
          Partial result: the native bounds stopped at {bounds}. Only what was kept is shown.
        </p>
      )}
      {preview.rows.length > 0 ? (
        <ul className="desktop-inspect-rows" aria-label="Bounded Accessibility evidence">
          {preview.rows.map((row) => (
            <li key={row.evidenceId} data-depth={Math.min(row.depth, 6)}>
              <span className="desktop-inspect-id">{row.evidenceId}</span>
              <span className="desktop-inspect-role">{row.role}{row.redacted ? ' · redacted' : ''}</span>
              {row.label !== null && <p>label: {row.label}{row.truncated ? ' …' : ''}</p>}
              {row.value !== null && <p>value: {row.value}{row.truncated ? ' …' : ''}</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="desktop-inspect-empty-preview">The bounded snapshot kept no label or value nodes.</p>
      )}
      {preview.omittedRows > 0 && (
        <p className="desktop-inspect-omitted">
          +{preview.omittedRows} more nodes stayed in the bounded snapshot but are not shown in this preview.
        </p>
      )}
      <p className="desktop-inspect-handoff">Open Mission Control → Desktop to ask about this snapshot.</p>
      <p className="desktop-inspect-caption">This is a {DESKTOP_PREVIEW_LABEL}. Not spoken.</p>
    </section>
  );
}

export function DesktopInspectResultPanel({ state }: { state: DesktopInspectState }) {
  if (state.kind === 'idle') {
    return (
      <p className="desktop-inspect-idle">
        No preview yet. Inspect window reads the focused window once, on demand — nothing runs in the background.
      </p>
    );
  }
  if (state.kind === 'blocked') {
    return (
      <p className="desktop-inspect-blocked" role="status">
        {state.activeProjects === 0
          ? 'No active Work project. Open Mission Control → Work and connect a project; the widget never guesses scope from window titles.'
          : `${state.activeProjects} projects are active. Choose one in Mission Control → Work; the widget remembers your selection.`}
      </p>
    );
  }
  if (state.kind === 'limited') {
    return (
      <section className="desktop-inspect-limited" data-code={state.code} role="status">
        <p className="desktop-inspect-limited-title">{DESKTOP_DENIAL_COPY[state.code]}</p>
        {state.detail !== null && <p className="desktop-inspect-detail">Native detail: {state.detail}</p>}
        <p className="desktop-inspect-caption">This is a {DESKTOP_PREVIEW_LABEL}. Nothing was invented.</p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="desktop-inspect-error" role="alert" data-reason={state.reason}>
        <p>{state.message}</p>
        {state.projectLabel !== null && <p className="desktop-inspect-detail">Scope: {state.projectLabel}</p>}
      </section>
    );
  }
  return <PreviewPanel preview={state.preview} projectLabel={state.projectLabel} />;
}
