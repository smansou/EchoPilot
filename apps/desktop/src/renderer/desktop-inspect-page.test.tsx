/**
 * C05 Mission Control tests: the Desktop page documents the widget's read-only inspection.
 *
 * The page is pinned here so the copy can never drift into claiming an unconnected capability:
 * helper readiness is reported truthfully, the flow is named as a local Accessibility preview,
 * OCR, desktop actions, and intelligent C01 answers stay explicitly listed as not connected, and
 * the grounded question card is named as the place where sends can happen — only after review.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopInspectPage } from './desktop-inspect-page';

const noop = () => {};

test('C05 Mission Control: the Desktop page reports helper readiness for every state', () => {
  const missing = renderToStaticMarkup(<DesktopInspectPage
    observe={{ helperFound: false, helperPath: null, searched: ['/app/dist/native/echopilot-desktop'] }}
    onOpenWork={noop}
  />);
  assert.ok(missing.includes('Helper missing'), 'a missing helper is visible, not hidden');
  assert.ok(missing.includes('pnpm dev'), 'the missing helper names the build step');
  assert.ok(missing.includes('dist/native/echopilot-desktop'), 'the missing helper names the expected artifact');
  assert.ok(missing.includes('Searched: /app/dist/native/echopilot-desktop'), 'the searched locations are disclosed');

  const ready = renderToStaticMarkup(<DesktopInspectPage
    observe={{ helperFound: true, helperPath: '/app/dist/native/echopilot-desktop', searched: ['/app/dist/native/echopilot-desktop'] }}
    onOpenWork={noop}
  />);
  assert.ok(ready.includes('Helper ready'), 'a present helper is reported as ready');
  assert.ok(ready.includes('/app/dist/native/echopilot-desktop'), 'the resolved helper path is shown for diagnostics');
  assert.ok(!ready.includes('helper is missing'), 'readiness never contradicts itself');

  const checking = renderToStaticMarkup(<DesktopInspectPage observe={null} onOpenWork={noop} />);
  assert.ok(checking.includes('Checking helper'), 'an unknown state says it is still checking');
  assert.ok(!checking.includes('Helper ready'), 'an unknown state never claims readiness');
});

test('C05 Mission Control: the Desktop page explains the read-only flow and claims nothing more', () => {
  const markup = renderToStaticMarkup(<DesktopInspectPage
    observe={{ helperFound: true, helperPath: null, searched: [] }}
    onOpenWork={noop}
  />);
  assert.ok(markup.includes('Inspect window'), 'the page names the widget affordance');
  assert.ok(markup.includes('local Accessibility preview — no AI answer or screenshot'), 'the exact disclosure is repeated');
  assert.ok(markup.includes('no background capture'), 'the page states there is no background capture');
  assert.ok(markup.includes('never spoken, never stored, and never sent to an API'), 'the locality promise is explicit');
  assert.ok(markup.includes('Not connected in this build: OCR, desktop actions, and intelligent C01 answers.'), 'the unconnected capabilities are listed');
  assert.ok(markup.includes('Ask about the latest snapshot'), 'the page names the grounded question card that renders below it');
  assert.ok(markup.includes('inspecting, opening, and previewing never send, and the exact prompt is always reviewed before any send'), 'the page states the send boundary truthfully');
  assert.ok(markup.includes('several active projects show a choose-one instruction'), 'scope resolution is described honestly');
  assert.ok(markup.includes('Open Work ↗'), 'the page links to the Work picker');
  assert.ok(!/\b(OCR|desktop actions|C01 answers) (is|are) ready\b/i.test(markup), 'no unconnected capability is claimed ready');
});
