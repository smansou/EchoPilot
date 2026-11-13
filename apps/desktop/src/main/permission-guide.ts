import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences,
} from "electron";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  permissionPanes,
  permissionPlan,
  type MacPermission,
} from "./permission-plan";
export function createPermissionGuide(options: {
  bundleDir: string;
  desktopHelper(): string | null;
  permissions(): Promise<Record<string, unknown>>;
}) {
  let window: BrowserWindow | null = null;
  let current: ReturnType<typeof permissionPlan> | null = null;
  const url = "echo://app/index.html?view=permission";
  const owns = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    !!window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame?.url === url;
  const appBundle = () => {
    const macOS = dirname(process.execPath);
    return app.isPackaged && macOS.endsWith("/Contents/MacOS")
      ? resolve(macOS, "../..")
      : null;
  };
  async function state() {
    if (!current) throw Error("Open a permission guide first.");
    const permissions = await options.permissions();
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (
        candidate.webContents.getURL() ===
        "echo://app/index.html?view=dashboard"
      )
        candidate.webContents.send("echo:permissions-updated", permissions);
    }
    const targets = await Promise.all(
      current.targets.map(async (target) => {
        let icon = "";
        try {
          icon = (
            await app.getFileIcon(target.file, { size: "normal" })
          ).toDataURL();
        } catch {}
        return {
          id: target.id,
          label: target.label,
          detail: target.detail,
          icon,
          exists: existsSync(target.file),
          granted:
            current!.permission === "Accessibility"
              ? permissions.accessibility === true
              : target.id === "app"
                ? permissions.screenApp === "granted"
                : permissions.screenHelper === "granted",
        };
      }),
    );
    const granted =
      current.permission === "Accessibility"
        ? permissions.accessibility === true
        : current.permission === "Screen Recording"
          ? permissions.screen === "granted"
          : current.permission === "Microphone"
            ? permissions.microphone === "granted"
            : permissions.camera === "granted";
    return {
      permission: current.permission,
      draggable: current.draggable,
      targets,
      granted,
      permissions,
    };
  }
  function targetFor(id: unknown) {
    const target = current?.targets.find((t) => t.id === id);
    if (!target || !existsSync(target.file))
      throw Error(
        "This permission item is unavailable. Reopen the guide from your current Cleo app.",
      );
    return target;
  }
  ipcMain.on("echo:permission-drag", (event, id: unknown) => {
    if (!owns(event)) return;
    try {
      const target = targetFor(id);
      const icon = nativeImage
        .createFromPath(join(app.getAppPath(), "assets/branding/cleo.icns"))
        .resize({ width: 64, height: 64 });
      event.sender.startDrag({ file: target.file, icon });
    } catch {
      window?.webContents.send(
        "echo:permission-error",
        "Could not start the drag. Use Show in Finder instead.",
      );
    }
  });
  ipcMain.handle("echo:permission-guide", async (event, input: unknown) => {
    if (!owns(event) || !input || typeof input !== "object")
      throw Error("Untrusted permission request.");
    const request = input as Record<string, unknown>;
    if (request.action === "status") return state();
    if (request.action === "close") {
      window?.close();
      return;
    }
    if (request.action === "reveal") {
      shell.showItemInFolder(targetFor(request.id).file);
      return;
    }
    if (request.action === "settings" && current) {
      await shell.openExternal(
        `x-apple.systempreferences:com.apple.preference.security?${current.pane}`,
      );
      return;
    }
    throw Error("Unknown permission guide action.");
  });
  return {
    async open(permission: unknown) {
      if (
        typeof permission !== "string" ||
        !Object.hasOwn(permissionPanes, permission)
      )
        throw Error("Unknown permission.");
      const name = permission as MacPermission;
      if (
        (name === "Microphone" || name === "Camera") &&
        systemPreferences.getMediaAccessStatus(
          name === "Microphone" ? "microphone" : "camera",
        ) === "not-determined"
      ) {
        const granted = await systemPreferences.askForMediaAccess(
          name === "Microphone" ? "microphone" : "camera",
        );
        if (granted) return { granted: true };
      }
      current = permissionPlan(name, appBundle(), options.desktopHelper());
      if (!window || window.isDestroyed()) {
        const area = screen.getDisplayNearestPoint(
          screen.getCursorScreenPoint(),
        ).workArea;
        window = new BrowserWindow({
          width: 340,
          height: 560,
          x: area.x + 20,
          y: area.y + Math.max(20, Math.round((area.height - 560) / 2)),
          show: false,
          title: "Allow Cleo access",
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          backgroundColor: "#f7f6fb",
          webPreferences: {
            preload: join(options.bundleDir, "../preload/index.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        });
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) =>
          event.preventDefault(),
        );
        window.on("closed", () => {
          window = null;
        });
        await window.loadURL(url);
      } else {
        await window.loadURL(url);
      }
      await shell.openExternal(
        `x-apple.systempreferences:com.apple.preference.security?${current.pane}`,
      );
      window.showInactive();
      return { guided: true };
    },
    dispose() {
      window?.destroy();
      window = null;
      ipcMain.removeHandler("echo:permission-guide");
      ipcMain.removeAllListeners("echo:permission-drag");
    },
  };
}
