export type MacPermission =
  "Accessibility" | "Screen Recording" | "Microphone" | "Camera";
export const permissionPanes: Record<MacPermission, string> = {
  Accessibility: "Privacy_Accessibility",
  "Screen Recording": "Privacy_ScreenCapture",
  Microphone: "Privacy_Microphone",
  Camera: "Privacy_Camera",
};
export function permissionPlan(
  permission: MacPermission,
  appBundle: string | null,
  desktopHelper: string | null,
) {
  if (!Object.hasOwn(permissionPanes, permission))
    throw Error("Unknown permission.");
  const targets: { id: string; label: string; detail: string; file: string }[] =
    [];
  if (permission === "Accessibility" || permission === "Screen Recording") {
    if (permission === "Screen Recording" && appBundle)
      targets.push({
        id: "app",
        label: "Cleo",
        detail: "For visual screen context",
        file: appBundle,
      });
    if (desktopHelper)
      targets.push({
        id: "desktop",
        label: "Cleo desktop helper",
        detail: "Appears as echopilot-desktop in macOS",
        file: desktopHelper,
      });
  }
  return {
    permission,
    pane: permissionPanes[permission],
    draggable: targets.length > 0,
    targets,
  };
}
