# Cleo Orb Studio

Run `node scripts/orb-studio.mjs` and open http://127.0.0.1:4176. Set `CLEO_STUDIO_PORT` if another local port is needed.

The editor starts from proposal D and offers A–F as presets, using the original orb shading and the light/dark tile gradients. Drag to position; arrow keys nudge one artwork pixel, or ten with Shift. Sliders and numeric fields control position and radius. Small previews show the same composition at Dock/icon sizes. Undo, preset reset, background choice, SVG download, and settings copy are included.

Edits are retained in this browser's local storage. **Save this composition** writes `artifacts/branding/selection.json` and `selection.svg` on this Mac. Saving does not install the icon; wait for the user's instruction to use it. The server binds only to the IPv4 loopback interface, serves only editor files, and accepts same-origin saves with bounded values.

Verified in Chrome: page rendering, live numeric position changes, and preset reset. The studio is a design tool and is not part of the shipped app UI.
