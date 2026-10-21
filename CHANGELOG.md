# Changelog

## 0.1.3

### Fixed

- Render native Pi images with Kitty Unicode placeholders in interactive Herdr sessions so text overlays cover them correctly.
- Restore the native image renderer and remove the adapter's uploaded images on shutdown or reload. Existing tmux rendering is unchanged.

The Herdr adapter supports image grids up to 89 rows. Larger grids or unrecognized native image output retain Pi's native rendering.
