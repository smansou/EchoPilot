import type {
  PermissionSnapshot,
  PermissionName,
} from "../main/desktop-permissions";
type Props = {
  permissions: Partial<PermissionSnapshot>;
  sharing: { enabled?: boolean; requested?: boolean };
  request(input: Record<string, unknown>): Promise<any>;
  setPermissions(value: PermissionSnapshot): void;
  toggleScreen(): void;
  busy: boolean;
  onError(message: string): void;
};
export function PermissionSettings({
  permissions,
  sharing,
  request,
  setPermissions,
  toggleScreen,
  busy,
  onError,
}: Props) {
  const entries: [PermissionName, boolean | null, string, string][] = [
    [
      "Microphone",
      permissions.microphone === "granted",
      "For conversations and dictation.",
      permissions.microphone || "unknown",
    ],
    [
      "Accessibility",
      permissions.accessibility ?? null,
      "Read app controls, point to content, and insert dictated text.",
      permissions.accessibility === true
        ? "granted"
        : permissions.accessibility === false
          ? "denied"
          : "unknown",
    ],
    [
      "Screen Recording",
      permissions.screen === "granted",
      "Optional visual context when you turn on screen context.",
      permissions.screen || "unknown",
    ],
    [
      "Camera",
      permissions.camera === "granted",
      "Only used by experimental gaze.",
      permissions.camera || "unknown",
    ],
  ];
  async function allow(permission: PermissionName) {
    try {
      setPermissions(await request({ action: "open-permission", permission }));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not request access.");
    }
  }
  return (
    <>
      <div className="ws-setting-row">
        <div>
          <h3>Screen context during voice</h3>
          <p>
            Let Cleo understand your screen and point to what it’s explaining.
          </p>
          {sharing.requested && !sharing.enabled && (
            <p role="status">
              Waiting for macOS access. This turns on automatically when access
              is available.
            </p>
          )}
        </div>
        <button
          className="ws-switch"
          role="switch"
          aria-label="Screen context"
          disabled={busy}
          aria-checked={sharing.requested ?? sharing.enabled ?? false}
          onClick={toggleScreen}
        >
          <i />
        </button>
      </div>
      {entries.map(([name, allowed, detail, status]) => (
        <div className="ws-setting-row" key={name}>
          <div>
            <h3>{name}</h3>
            <p>{detail}</p>
            {name === "Accessibility" && permissions.desktopError && (
              <p role="status">{permissions.desktopError}</p>
            )}
            {permissions.restartRequired?.includes(name) && (
              <p>
                If you’ve enabled this in System Settings, restart Cleo to apply
                the change.
              </p>
            )}
          </div>
          {permissions.restartRequired?.includes(name) ? (
            <div className="ws-permission-recovery">
              <button className="ws-small" onClick={() => void allow(name)}>
                Open System Settings ↗
              </button>
              <button
                className="ws-link"
                onClick={() =>
                  void request({ action: "restart-for-permissions" }).catch(
                    (e: Error) => onError(e.message),
                  )
                }
              >
                Restart Cleo
              </button>
            </div>
          ) : allowed ? (
            <span className="ws-allowed">Allowed</span>
          ) : status === "restricted" ? (
            <span>Restricted by macOS</span>
          ) : (
            <button
              className="ws-small"
              disabled={busy}
              onClick={() => void allow(name)}
            >
              {permissions.settingsRequired?.includes(name) ||
              ((name === "Camera" || name === "Microphone") &&
                status === "denied")
                ? "Open System Settings ↗"
                : "Request access"}
            </button>
          )}
        </div>
      ))}
    </>
  );
}
