# WebSend CLI receiver (advanced)

A minimal Node script that pairs as a **receiver** against a deployed WebSend
instance from a terminal. Useful for remote-instance smoke testing and
headless captures. Not intended for end users — the browser flow is the
supported path.

> Built with the help of [Claude Code](https://claude.ai/claude-code).

## Install

No new dependencies are added — the script reuses Playwright (already a
project devDependency for the e2e tests). If you have not yet installed the
Chromium browser binary:

```sh
cd src
npm install
npx playwright install chromium
```

## Use

```sh
node src/cli/receive.js https://websend.example.com
```

Options:

| flag             | default                                      | meaning                                   |
|------------------|----------------------------------------------|-------------------------------------------|
| `--out <dir>`    | `./websend-received/<timestamp>`             | Where decrypted files are written         |
| `--auto-accept`  | off                                          | Skip the fingerprint y/n prompt           |
| `-v`, `--verbose`| off                                          | Print protocol/crypto debug logs          |
| `-h`, `--help`   |                                              | Show usage                                |

The script prints the sender URL; open or scan it on the phone, confirm the
fingerprint matches in both places, and incoming photos / PDFs / files are
written verbatim to the output directory.

## How it works

To avoid adding a native node-webrtc dependency (and the supply-chain risk
that comes with it), the actual WebRTC + crypto flow runs inside a
Playwright-launched headless Chromium. The Node script:

1. Launches Chromium and navigates to the instance URL (so `fetch()` carries
   the right `Origin` header).
2. Loads `/js/crypto.js` and `/js/protocol.js` from the live server via
   `page.addScriptTag` — exactly the production receiver code.
3. Injects `shim.js` (in this directory) as the in-browser driver.
4. Bridges the y/n fingerprint prompt and file saves back to Node via
   `page.exposeFunction`.

Because the wire protocol modules are loaded directly from the server, any
change to them automatically flows through — zero drift between this CLI and
the browser receiver.

## Scope

- Receives only — no sender mode
- Saves raw decrypted files; no OCR / B&W / PDF assembly (run those manually
  with `tesseract` / `magick` if needed)
- Ignores `transform-image`, `replace-image`, `delete-image` messages

If the browser modules change in a way that breaks this client, fix the
client — do not duplicate the protocol here.
