# pi-render-images-tmux

Pi extension that makes the built-in `read` tool render image attachments inline inside tmux when the outer terminal is Ghostty or kitty.

It keeps Pi core untouched. The extension re-registers the built-in `read` tool, delegates execution to Pi's original implementation, and only overrides the terminal renderer for image results.

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

## Required tmux config

```tmux
set -g allow-passthrough on
set -ga update-environment TERM
set -ga update-environment TERM_PROGRAM
```

Restart tmux after changing those options.
