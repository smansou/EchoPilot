# Local camera gaze helper

`bash build.sh` builds and signs `dist/native/echopilot-gaze` offline. The parent starts the helper only after an explicit camera enable request with the chosen display identifier. Private stdin `stop` or EOF stops capture; the parent also terminates the process on scope change or disposal.

AVFoundation captures at VGA resolution. Vision detects a single face, two eye contours, and both pupil landmarks. Eye-relative pupil geometry is emitted at most six times per second. Absent pupil evidence, occlusion, invalid geometry, and multiple faces emit no gaze observation. Raw camera buffers remain inside the delegate callback; no images are saved or sent. Head position never substitutes for missing pupil evidence.

The main-process host owns nine calibration targets plus five held-out targets and the existing uncertainty-aware gaze runtime. Each target requires at least 1.2 seconds and two usable pupil observations. Calibration and the ten-second sample ring are held in memory only. Display changes invalidate calibration; absent recent pupil observations report tracking loss. Gaze does not confirm actions or move the pointer.

Validation: pure measured geometry tests, compiled AVFoundation/Vision code, and main-process lifecycle/calibration tests with metadata inputs. These checks do not qualify physical camera accuracy, TCC permission UI, lighting conditions, cross-display UI placement, or a signed distribution. Physical testing remains required. A dedicated-device hardware adapter and browser/editor connectors are not bundled.
