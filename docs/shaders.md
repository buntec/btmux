# Shader wallpapers

Shader wallpapers use the MIT-licensed [Shaders](https://shaders.com/docs/guide)
components, bundled locally with btmux. A wallpaper is a stack of up to 8 layers,
composed like Shaders' [layers](https://shaders.com/docs/guide/composing-effects):
generators draw new content, and an effect processes every layer beneath it. Build
the stack in Settings → Wallpaper: add, reorder, disable, or remove layers, and edit
each layer's native parameters. Changes preview immediately; Apply changes only the
running server, and Show TOML copies the settings to persist them.

```toml
wallpaper-opacity = 0.25
wallpaper-speed = 0.2
wallpaper-fps = 30
wallpaper-resolution = 0.4

# Bottom layer first.
[[wallpaper-shader]]
shader = "ink-flow"
[wallpaper-shader.params]
color-mode = "custom"
radius = 0.25

[[wallpaper-shader]]
shader = "pixelate"
params = { scale = 40 }

[[wallpaper-shader]]
shader = "film-grain"
blend-mode = "soft-light"  # how the layer composites over those beneath it
opacity = 0.6              # 0.0-1.0, default 1.0
enabled = true             # keep a layer configured but hidden
interactive = true         # whether pointer and terminal-cursor input reach it
```

Generators include gradients, noise fields, `aurora`, `plasma`, `strands`, and the
interactive `chroma-flow`, `cursor-trail`, `ink-flow`, and `boids`, plus a
`lens-flare` overlay. Effects include every Shaders Stylize effect (for example
`ascii`, `crt-screen`, `dither`, `film-grain`, `glitch`, `halftone`, `pixelate`,
`vhs`, `vignette`, and `watercolor`) and the color adjustments (`brightness-contrast`,
`duotone`, `hue-shift`, `saturation`, `tint`, and others). Settings lists them all.

Blend modes are `normal`, `normal-oklch`, `normal-oklab`, `multiply`, `screen`,
`linear-dodge`, `overlay`, `difference`, `color-dodge`, `exclusion`, `color`,
`luminosity`, `darken`, `lighten`, `color-burn`, `linear-burn`, `soft-light`,
`hard-light`, `hue`, and `saturation`.

Parameter names use kebab-case, matching the Settings TOML export; colors, numbers,
booleans, text, positions, and gradient stop arrays are supported. Each layer uses
its shader's native defaults, including its numeric `seed` when provided. The global
wallpaper speed multiplies native speed parameters, or scales simulation time for
interactive effects. Cursor-following moves `center`, `position`, or
`light-position` on interactive layers and supplies input to interactive effects;
the cursor-following switches control which input sources reach them. Choosing a
different shader for a layer resets that layer's parameters.

Randomize parameters, below each layer's controls, generates a complete parameter
set including native seeds. Colors share a coordinated palette, gradient stops stay
ordered, and numeric values stay within sensible native ranges. It previews
immediately and changes only that layer; Apply and the TOML export work as with
manual edits.

WebGPU is required; unsupported browsers and GPU failures leave the theme
background visible. Frame rates are capped to 10–60 FPS, and background tabs,
modal transitions, and disabled animations pause continuous rendering. Wallpaper
changes preserve terminal instances and pane sockets, and layer edits keep the
simulation state of unchanged layers. No hosted presets or runtime shader downloads
are used, and shader telemetry is disabled by using the core renderer without a
telemetry collector.

After updating the pinned `shaders` dependency, run `just sync-shaders` to refresh
its parameter metadata and lazy loaders. To offer another Shaders component, add it
to the `generators` or `effects` list in `scripts/sync-shaders.mjs`.
