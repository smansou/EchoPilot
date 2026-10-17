// Compatibility entry point for the current hands-free calibration UI.
// Uses the production renderer/host with a synthetic camera at 800×600.
process.argv.push('--compact');
await import('./gaze-renderer-smoke.mjs');
