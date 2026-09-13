# Security policy

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting**: open the
[Security tab](https://github.com/drftrun/driftengine/security/advisories/new) and file a draft
advisory. It reaches the maintainer privately, it cannot be read by anyone else while it is open,
and it produces a CVE and a published advisory if one is warranted.

**Please do not open a public issue for a vulnerability**, and please do not include a working
exploit in the first report. A description of the class of problem, the affected version and the
conditions that reach it is enough to start.

You should get an acknowledgement within a week. If a fix is warranted it ships in a patch release
and the advisory names the versions affected.

## What is in scope

This is a rendering and simulation engine that runs in a browser or inside a packaged shell, so the
interesting surface is the data it is asked to read:

- **The model readers** — `.drft`, glTF, FBX, OBJ, STL, USD, `.kn5`, and the Gaussian splat formats.
  These parse untrusted binary. A crafted file that reads out of bounds, allocates without limit or
  hangs the parser is a vulnerability.
- **`@driftengine/package`** — the desktop and Android shells, their preload boundary, and anything
  that decides what the shell will load or execute.
- **`@driftengine/network`** — a transport that accepts messages from a peer or a relay.
- **`@driftengine/script`** — the capability surface a `.drs` script reaches, where the guarantee is
  that a script cannot reach past what its capabilities name.

## What is not

- A consumer's own game code, and anything a consumer chooses to pass the engine.
- Denial of service by asking the engine to draw more than the device can. The renderer degrades and
  reports rather than promising a frame rate.
- Findings that require the attacker to already run code in the same page.

## Supported versions

The current minor release. This engine has one maintainer; older lines are not patched.
