import { useEffect, useRef, useState } from "react";
import "./permission-guide.css";
const bridge = () => (window as any).echo;
export function PermissionGuide() {
  const inFlight = useRef(false);
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(false);
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      setState(await bridge().permissionGuide({ action: "status" }));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check access.");
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const off = bridge().onPermissionError?.(setError);
    return () => {
      window.removeEventListener("focus", onFocus);
      off?.();
    };
  }, []);
  useEffect(() => {
    if (state?.granted) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [state?.granted]);
  return (
    <main className="permission-guide">
      <span className="pg-eyebrow">CLEO · QUICK SETUP</span>
      <h1>
        {state?.granted
          ? "You’re all set."
          : state?.permission || "Allow access"}
      </h1>
      {state?.granted ? (
        <>
          <p className="pg-success">
            macOS confirms this permission is enabled.
          </p>
          <button
            className="pg-primary"
            onClick={() => void bridge().permissionGuide({ action: "close" })}
          >
            Done
          </button>
        </>
      ) : (
        <>
          <p>
            {state?.draggable
              ? "Drag the item below into the permission list in System Settings, then turn its switch on."
              : "Turn on Cleo in System Settings. macOS may ask you to unlock this setting."}
          </p>
          {state?.targets?.map((target: any) => (
            <div className="pg-item" key={target.id}>
              <div
                draggable={target.exists}
                tabIndex={0}
                aria-label={`Drag ${target.label} into System Settings`}
                onDragStart={(e) => {
                  e.preventDefault();
                  bridge().startPermissionDrag(target.id);
                }}
              >
                {target.icon && (
                  <img draggable={false} src={target.icon} alt="" />
                )}
                <strong>{target.label}</strong>
                <span>
                  {target.granted
                    ? "Access enabled ✓"
                    : target.exists
                      ? "Drag into System Settings ↗"
                      : "Item unavailable"}
                </span>
              </div>
              <small>{target.detail}</small>
              <button
                className="pg-link"
                onClick={() =>
                  void bridge().permissionGuide({
                    action: "reveal",
                    id: target.id,
                  })
                }
              >
                Show in Finder
              </button>
            </div>
          ))}
          {state?.permission === "Screen Recording" && (
            <p className="pg-note">
              Enable both items for screen text and visual context. If macOS
              asks to quit and reopen Cleo, follow that prompt.
            </p>
          )}
          {state && !state.draggable && (
            <p className="pg-note">
              Microphone and camera permissions use a macOS prompt and a switch.
              These panes don’t accept dragged apps.
            </p>
          )}
          <div className="pg-actions">
            <button
              className="pg-primary"
              disabled={checking}
              onClick={() => void refresh()}
            >
              {checking ? "Checking…" : "Check access"}
            </button>
            <button
              onClick={() =>
                void bridge().permissionGuide({ action: "settings" })
              }
            >
              Open System Settings ↗
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="pg-error">
          {error}
        </p>
      )}
      <button
        className="pg-link pg-later"
        onClick={() => void bridge().permissionGuide({ action: "close" })}
      >
        Close guide
      </button>
    </main>
  );
}
