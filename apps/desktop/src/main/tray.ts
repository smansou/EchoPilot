/**
 * F02 tray surface. The tray is the always-reachable control plane: every hotkey that failed to
 * register is listed here, and mute/stop stay clickable regardless of shortcut state.
 */
import { Menu, nativeImage, Tray as ElectronTray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { WIDGET_FALLBACK_CONTROLS, hotkeyActionLabel, type Shell } from './shell';
import { muteControlLabel, type WidgetSnapshot } from './widget-status';

/** 16x16 macOS template icon (monochrome mic glyph); template images adopt the menu bar tone. */
const TRAY_ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR4nGNgGOzgPxRTpJlsQ0YNoIIBDNS0nSyDqOYFigDFBtAeAAAMsifZQLmmGAAAAABJRU5ErkJggg==';

export type TrayOptions = Readonly<{
  shell: Shell;
  /**
   * The same coordinator-derived snapshot the widget renders (`index.ts` passes one function to
   * both surfaces). The tray never reads a second mute copy of its own.
   */
  status(): WidgetSnapshot;
  onShowWidget(): void;
  onOpenDashboard(): void;
  onQuit(): void;
}>;

export type ShellTray = Readonly<{
  dispose(): void;
  refresh(): void;
}>;

export function createShellTray(options: TrayOptions): ShellTray {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'));
  icon.setTemplateImage(true);
  const tray = new ElectronTray(icon);
  const { shell } = options;

  /** Only set `accelerator` when the shortcut actually registered; conflicts are explained below. */
  function shortcut(action: Parameters<Shell['registeredAccelerator']>[0]): MenuItemConstructorOptions {
    const accelerator = shell.registeredAccelerator(action);
    return accelerator ? { accelerator } : {};
  }

  function menuFor(status: WidgetSnapshot): Menu {
    const conflicts = shell.hotkeys.conflicts;
    const template: MenuItemConstructorOptions[] = [
      { label: 'Show widget', click: options.onShowWidget },
      { type: 'separator' },
      {
        label: muteControlLabel(status),
        enabled: WIDGET_FALLBACK_CONTROLS.includes('mute'),
        ...shortcut('mute-microphone'),
        click: () => { shell.activate('mute'); },
      },
      {
        label: 'Stop speech',
        enabled: WIDGET_FALLBACK_CONTROLS.includes('stop'),
        ...shortcut('stop-speech'),
        click: () => { shell.activate('stop'); },
      },
      {
        label: 'Replay latest',
        ...shortcut('replay'),
        click: () => { shell.invoke('replay'); },
      },
      { type: 'separator' },
      {
        label: status.helper === 'connected' ? 'Native helper: connected' : 'Native helper: disconnected',
        enabled: false,
      },
      conflicts.length === 0
        ? { label: 'All shortcuts registered', enabled: false }
        : {
          label: `${conflicts.length} shortcut conflict${conflicts.length === 1 ? '' : 's'}`,
          submenu: conflicts.map((conflict) => ({
            label: `${conflict.accelerator} — ${hotkeyActionLabel(conflict.action)}`,
            enabled: false,
          })),
        },
      { type: 'separator' },
      { label: 'Mission Control…', ...shortcut('open-mission-control'), click: options.onOpenDashboard },
      { type: 'separator' },
      { label: 'Quit EchoPilot', click: options.onQuit },
    ];
    return Menu.buildFromTemplate(template);
  }

  function refresh(): void {
    const status = options.status();
    tray.setToolTip(`EchoPilot · helper ${status.helper}`);
    tray.setContextMenu(menuFor(status));
  }

  refresh();
  const unsubscribe = shell.subscribe(() => { refresh(); });

  return Object.freeze({
    refresh,
    dispose: () => { unsubscribe(); tray.destroy(); },
  });
}
