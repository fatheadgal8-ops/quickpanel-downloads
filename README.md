# QuickPanel Desktop

A native desktop window around your live QuickPanel Dashboard. The website does all the
work, so every site update shows up in the app automatically — you almost never need to
rebuild it.

What it adds on top of the website: its own window + taskbar/Dock icon, stays signed in,
remembers its size/position, opens outside links in your normal browser, shows a friendly
"reconnecting" screen if the connection drops, and only runs one copy at a time.

## Which website does it open?

`app-config.json` holds the address (default `https://quickpanelrbx.freesrv.com`).
Change it before building:

    npm run set-url -- https://your-domain.com

Already-installed copies never need reinstalling if the site moves: on the "can't connect"
screen (or Help → "Change Site Address…") people can type the new address and the app
remembers it.

## Try it

    npm install
    npm start

## Build the installers

| Platform | Command | Output |
|---|---|---|
| macOS (run on a Mac) | `npm run dist:mac` | `dist/QuickPanel.dmg` — one app for Apple Silicon and Intel |
| Windows | `npm run dist:win` | `dist/QuickPanel-Setup.exe` — one-click installer |

Windows builds need no special tools when run on Windows. On a Mac or Linux machine the
Windows installer step additionally needs Wine installed (it generates the uninstaller).
macOS installers can only be built on a Mac.

## Put them on your website

Create a folder called `downloads` next to `main.py` and drop the files in it:

    downloads/QuickPanel-Setup.exe
    downloads/QuickPanel.dmg

The `/download` page and the `/download/windows` and `/download/mac` links pick them up
automatically. If the files are too big to upload to your host, upload them somewhere else
(GitHub Releases, Google Drive...) and set these environment variables to the direct links:

    DOWNLOAD_WINDOWS_URL=https://...
    DOWNLOAD_MAC_URL=https://...

## About the "unknown publisher" warnings

These builds are not signed with a paid code-signing certificate (Windows) or notarized by
Apple (macOS), so people see a one-time warning on first launch — the /download page
explains how to get past it. Removing the warnings requires buying certificates
(roughly $100–$400 per year); nothing in this project needs to change to add them later.

## Environment variables (optional)

- `QUICKPANEL_URL` — open this address instead of the saved one (handy for testing)
- `QP_DEBUG=1` — adds View → Developer Tools

## No Mac handy?

Upload this folder to a GitHub repo together with `.github/workflows/build-mac.yml` (see the workflow file
that came with it), then run it from the repo's Actions tab. GitHub builds the Mac app for you and attaches
`QuickPanel.dmg` to a release.

## Clips (new in 1.1.0)

Turn on **Clips → Record clips** (or the tray icon). While Roblox is open the app keeps about the last
45 seconds of the Roblox window in memory. Press **Ctrl+Shift+C** (Cmd+Shift+C on Mac) to save a clip:
it uploads to your QuickPanel account and opens a notification to name it and make a public link.

- Only the Roblox window is recorded, never the whole screen, and nothing is uploaded until you press the key.
- Windows records game sound (it includes anything playing on the PC, such as voice chat); turn it off in the Clips menu.
- macOS: allow QuickPanel under System Settings, Privacy & Security, Screen Recording. Sound is not recorded on Mac.
- With recording on, closing the window keeps QuickPanel running in the tray so the key keeps working. Quit from the tray icon.
- If you aren't signed in or the upload fails, the clip stays in `<user data>/clips` (kept 14 days).
