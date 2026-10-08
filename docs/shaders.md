# Shader wallpapers

Shader wallpapers use the MIT-licensed [Shaders](https://shaders.com/docs/guide)
components, bundled locally with btmux. Choose a generator in Settings → Wallpaper,
edit its native parameters, and copy the generated TOML to persist the settings.
Parameter changes preview immediately; Apply changes only the running server.

```toml
wallpaper-shader = "aurora"
wallpaper-opacity = 0.25
wallpaper-speed = 0.2
wallpaper-fps = 30
wallpaper-resolution = 0.4

[wallpaper-shader-params.aurora]
color-a = "#a533f8"
color-b = "#22ee88"
curtain-count = 3
speed = 2.0
center = { x = 0.5, y = 0.0 }
```

Each generator has its own parameter table. Names use kebab-case, matching the
Settings TOML export; colors, numbers, booleans, positions, and gradient stop arrays
are supported. The global wallpaper speed multiplies native speed parameters,
or scales simulation time for interactive effects.
Each shader uses its native parameter defaults, including its numeric `seed` when
provided. Cursor-following moves `center` or `position` on generators that expose
those parameters and supplies input to interactive effects.

Randomize parameters, below the selected shader's controls, generates a complete
parameter set including native seeds. Colors share a coordinated palette, gradient
stops stay ordered, and numeric values stay within sensible native ranges. It
previews immediately and changes only the selected shader's parameters; Apply and
the TOML export work as with manual edits.

Interactive wallpapers include `chroma-flow`, `cursor-trail`, `ink-flow`, and
`boids`, with their native parameters available in Settings. The flow and trail
effects respond to mouse or terminal-cursor movement; Boids animates an autonomous
flock that can attract or repel the cursor. The cursor-following switches control
which input sources reach them, and disabling animations freezes simulations.

WebGPU is required; unsupported browsers and GPU failures leave the theme
background visible. Frame rates are capped to 10–60 FPS, and background tabs,
modal transitions, and disabled animations pause continuous rendering. Wallpaper
changes preserve terminal instances and pane sockets. No hosted presets or
runtime shader downloads are used, and shader telemetry is disabled by using the
core renderer without a telemetry collector.

After updating the pinned `shaders` dependency, run `just sync-shaders` to refresh
its parameter metadata and lazy loaders.
