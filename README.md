# pi-render-images-tmux

Pi extension for inline images in Herdr and tmux. In tmux, it adds previews for `read` image results when the outer terminal is Ghostty or kitty.

In Herdr, it adapts Pi's native image renderer to use Kitty Unicode placeholders, so full-screen text overlays can cover images instead of leaving them floating over the view. It does not change tool results or the images sent to the model.

## Installation

```bash
pi install git:github.com/dantetekanem/pi-render-images-tmux
```

Then restart Pi or run:

```text
/reload
```

This repository is public, so no GitHub credentials are required for installation.

## Try without installing

```bash
pi -e git:github.com/dantetekanem/pi-render-images-tmux
```

## Usage

After installation, ask Pi to read an image file from inside tmux:

```text
read /path/to/image.png
```

If the outer terminal is Ghostty or kitty and tmux passthrough is enabled, the image renders inline in the tool result.

## How it works

Inside tmux, Pi's default terminal capability detection disables inline images. This extension uses the same pane-safe approach as `pi-emote`:

1. Detect tmux with `allow-passthrough on`.
2. Detect the outer terminal from tmux's `TERM_PROGRAM` environment.
3. For Ghostty/kitty, upload PNG image data with Kitty graphics virtual placement through tmux DCS passthrough.
4. Render a Unicode placeholder grid so tmux constrains the image to the pane.

Non-PNG images are converted to PNG before terminal preview.

## Herdr

Herdr support activates automatically in interactive sessions with `HERDR_ENV=1`. It sends Kitty commands directly to Herdr, without tmux passthrough or tmux configuration. Herdr [0.8.2 supports Unicode-placeholder placements](https://github.com/herdrdev/herdr/blob/v0.8.2/src/ghostty/mod.rs#L3533).

This is a version-sensitive workaround for Pi's native image-overlay composition: it wraps `Image.render` for the session and restores it on shutdown or reload. It handles Kitty image grids up to 89 rows; other image output keeps Pi's native rendering. No installed Pi files are modified. After updating this extension, run `/reload` and reopen the agent view to check the result in your terminal.

Focused checks (Node with TypeScript stripping):

```bash
node --experimental-strip-types --test index.test.ts
```

Set `PI_TUI_TEST_MODULE` to the running Pi's `pi-tui/dist/index.js` path to test that version, including its overlay compositor, rather than the locally installed peer dependency.

## Required tmux config

```tmux
set -g allow-passthrough on
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM
```

Restart tmux after changing those options.
