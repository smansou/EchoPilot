export type MediaStatus =
  "not-determined" | "granted" | "denied" | "restricted" | "unknown";
export type PermissionName =
  "Accessibility" | "Screen Recording" | "Microphone" | "Camera";
export type PermissionSnapshot = {
  microphone: MediaStatus;
  camera: MediaStatus;
  screen: MediaStatus;
  accessibility: boolean | null;
  desktopError: string | null;
  restartRequired: string[];
  settingsRequired: string[];
};
export type DesktopPermissionReport = {
  permission?: string;
  microphone?: string;
  camera?: string;
};
const names: PermissionName[] = [
  "Accessibility",
  "Screen Recording",
  "Microphone",
  "Camera",
];
const panes: Record<PermissionName, string> = {
  Accessibility: "Privacy_Accessibility",
  "Screen Recording": "Privacy_ScreenCapture",
  Microphone: "Privacy_Microphone",
  Camera: "Privacy_Camera",
};
/** Request only after a user action; status reads and focus refresh never trigger OS prompts. */
export function createDesktopPermissions(options: {
  media(type: "microphone" | "camera" | "screen"): MediaStatus;
  desktop(prompt: boolean): Promise<DesktopPermissionReport>;
  askMedia(type: "microphone" | "camera"): Promise<boolean>;
  askScreen(): Promise<void>;
  openSettings(pane: string): Promise<unknown>;
  changed(state: PermissionSnapshot): void;
}) {
  let flight: Promise<PermissionSnapshot> | null = null,
    last = "",
    requestFlight: Promise<PermissionSnapshot> | null = null;
  const attempted = new Set<PermissionName>();
  function read() {
    if (flight) return flight;
    const task = (async () => {
      const microphone = options.media("microphone"),
        camera = options.media("camera"),
        screen = options.media("screen");
      let report: DesktopPermissionReport = {},
        desktopError: string | null = null;
      try {
        report = await options.desktop(false);
      } catch {
        desktopError = "Could not check desktop access. Try reopening Cleo.";
      }
      // Electron documents restart recovery after denied media access is changed
      // in System Settings. Do not treat another process's media grant as ours.
      const restartRequired: string[] = [];
      if (microphone === "denied") restartRequired.push("Microphone");
      if (camera === "denied") restartRequired.push("Camera");
      const state: PermissionSnapshot = {
        microphone,
        camera,
        screen,
        accessibility:
          report.permission === "granted"
            ? true
            : report.permission === "denied"
              ? false
              : null,
        desktopError,
        restartRequired,
        settingsRequired: [...attempted].filter((name) =>
          name === "Accessibility"
            ? report.permission !== "granted"
            : name === "Screen Recording"
              ? screen !== "granted"
              : name === "Camera"
                ? camera === "denied"
                : microphone === "denied",
        ),
      };
      const encoded = JSON.stringify(state);
      if (encoded !== last) {
        last = encoded;
        options.changed(state);
      }
      return state;
    })();
    flight = task;
    void task.then(
      () => {
        if (flight === task) flight = null;
      },
      () => {
        if (flight === task) flight = null;
      },
    );
    return task;
  }
  async function request(name: unknown) {
    if (!names.includes(name as PermissionName))
      throw Error("Unknown permission.");
    if (requestFlight) return requestFlight;
    const permission = name as PermissionName;
    const task = (async () => {
      const current = await read();
      if (
        (permission === "Accessibility" && current.accessibility === true) ||
        (permission === "Screen Recording" && current.screen === "granted") ||
        (permission === "Microphone" && current.microphone === "granted") ||
        (permission === "Camera" && current.camera === "granted")
      )
        return current;
      if (current.settingsRequired.includes(permission)) {
        await options.openSettings(panes[permission]);
        return read();
      }
      attempted.add(permission);
      if (permission === "Accessibility") {
        await options.desktop(true);
      } else if (permission === "Screen Recording") {
        try {
          await options.askScreen();
        } catch {
          /* A native denial is reflected by the next read, not a custom modal. */
        }
      } else {
        const type = permission === "Camera" ? "camera" : "microphone";
        if (options.media(type) === "denied") {
          await options.openSettings(panes[permission]);
        } else if (options.media(type) !== "restricted") {
          await options.askMedia(type);
        }
      }
      return read();
    })();
    requestFlight = task;
    try {
      return await task;
    } finally {
      if (requestFlight === task) requestFlight = null;
    }
  }
  return { read, request };
}
