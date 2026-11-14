// A pixel-art fish tank. Plain TypeScript with only erasable syntax, so
// scripts/sync-shaders.mjs can import it in Node.
import { ctx, defineShader, transformColor, wgsl } from 'shaders/std';

/** An sRGB hex color as a linear `vec3f` literal. */
function linear(hex: string): string {
  const channels = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);
  return `vec3f(${channels.map((c) => c.toFixed(4)).join(', ')})`;
}

/** A pseudo-random value in [0, 1) from an f32 expression and the seed (Hoskins' hash11). */
const hash = (x: string) => {
  const p = `fract((${x}) * 0.1031 + seed * 0.0713)`;
  return `fract(2.0 * pow(${p} * (${p} + 33.33), 2.0))`;
};

/** The top row of the sand at art-pixel column `x`. */
const sandTop = (x: string) =>
  `(H - sandRows - round(sin((${x}) * 0.06 + seed) * 2.0 + sin((${x}) * 0.17 + seed * 2.0)))`;

// Body, accent, and pattern (0 plain, 1 bands, 2 two-tone, 3 stripe).
const SPECIES = [
  ['#ff7b1c', '#fff4e0', 1],
  ['#ffd93b', '#ffa51f', 0],
  ['#2f6bff', '#ffd93b', 2],
  ['#ff3b5c', '#ffd0d8', 3],
  ['#9b4dff', '#ffd23b', 2],
  ['#34e0c8', '#ff4f6d', 3],
  ['#e8e8f0', '#ff7b1c', 1],
] as const;

const body = `
  // Shrink cells, never stretch one axis, to keep at least 32x24 of them.
  let cellSize = min(max(pixelSize, 1.0), min(screen.x / 32.0, screen.y / 24.0));
  let gridSize = floor(screen / cellSize + 0.001);
  let cell = floor(uv * gridSize);
  let pc = cell + 0.5;
  let W = gridSize.x;
  let H = gridSize.y;
  let depth = pc.y / H;

  var bayer = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  let dither = (bayer[(u32(cell.y) % 4u) * 4u + u32(cell.x) % 4u] + 0.5) / 16.0 - 0.5;

  // Water in dithered bands.
  let band = clamp(floor(depth * 7.0 + dither + 0.5) / 7.0, 0.0, 1.0);
  var color = mix(waterTop.rgb, waterBottom.rgb, band);

  // Light rays from the surface.
  let slant = pc.x + pc.y * 0.55;
  let ray = sin(slant * 0.11 + time * 0.25) * sin(slant * 0.043 - time * 0.13);
  if (smoothstep(0.35, 0.95, ray) * (1.0 - depth) + dither * 0.35 > 0.4) {
    color = mix(color, waterTop.rgb * 1.6 + vec3f(0.02), 0.18);
  }

  // Sand, speckled, with pebbles.
  let sandRows = max(4.0, round(H * 0.12));
  let floorY = ${sandTop('cell.x')};
  if (cell.y >= floorY) {
    color = sand.rgb;
    let grain = ${hash('cell.x * 1.37 + cell.y * 57.1')};
    if (cell.y == floorY) {
      color = sand.rgb * 1.25;
    } else if (grain > 0.86) {
      color = sand.rgb * 0.7;
    } else if (grain < 0.05) {
      color = sand.rgb * 1.2;
    }
    let pebbleCell = floor(cell / 3.0);
    let pebble = ${hash('pebbleCell.x * 3.1 + pebbleCell.y * 17.3 + 5.0')};
    let inPebble = cell - pebbleCell * 3.0;
    if (pebble > 0.93 && cell.y > floorY + 1.0 && inPebble.y == 1.0 && inPebble.x < 2.0) {
      color = mix(sand.rgb * 0.45, vec3f(0.5, 0.25, 0.15), fract(pebble * 13.0));
    }
  }

  // Rocks.
  for (var k = 0u; k < 3u; k = k + 1u) {
    let fk = f32(k);
    let rx = floor(W * (0.1 + 0.8 * ${hash('fk * 7.3 + 41.0')}));
    let rw = round(6.0 + 9.0 * ${hash('fk * 3.7 + 43.0')});
    let rh = round(rw * (0.55 + 0.4 * ${hash('fk * 5.1 + 47.0')}));
    let rbase = ${sandTop('rx')} + 2.0;
    let q = vec2f((pc.x - rx - 0.5) / rw, (pc.y - rbase) / rh);
    if (q.y < 0.0 && dot(q, q) <= 1.0) {
      let light = dot(normalize(q + vec2f(0.0001)), vec2f(-0.6, -0.8));
      let tone = floor(clamp(light * 0.5 + 0.5 + dither * 0.3, 0.0, 0.999) * 3.0);
      color = mix(vec3f(0.06, 0.07, 0.09), vec3f(0.30, 0.31, 0.36), tone / 2.0);
      if (dot(q, q) > 0.75 && q.y > -0.95) {
        color = vec3f(0.04, 0.05, 0.07);
      }
    }
  }

  // Swaying plants.
  for (var k = 0u; k < u32(plants); k = k + 1u) {
    let fk = f32(k);
    let px0 = floor(W * ${hash('fk * 3.1 + 1.0')});
    let tall = floor(H * (0.2 + 0.4 * ${hash('fk * 5.7 + 2.0')}));
    let pbase = ${sandTop('px0')} + 1.0;
    let t = (pbase - pc.y) / tall;
    if (t >= 0.0 && t <= 1.0) {
      let sway = round(sin(time * 0.9 + fk * 1.7 + pc.y * 0.16) * t * t * 3.0);
      let dx = pc.x - (px0 + 0.5 + sway);
      let row = u32(cell.y) + k * 3u;
      let leaf = f32(row % 6u);
      let side = select(-1.0, 1.0, (row / 6u) % 2u == 0u);
      let kind = ${hash('fk * 9.3 + 3.0')};
      let green = select(plant.rgb, vec3f(plant.r * 1.4, plant.g * 1.1, plant.b * 0.5), kind > 0.6);
      if (dx == 0.0) {
        color = green * 0.75;
      } else if (leaf < 3.0 && dx * side > 0.0 && dx * side <= 3.0 - leaf && t < 0.97) {
        color = select(green, green * 1.25, dx * side == 1.0);
      }
    }
  }

  // Fish.
  var palette = array<vec3f, ${SPECIES.length}>(${SPECIES.map(([main]) => linear(main)).join(', ')});
  var accents = array<vec3f, ${SPECIES.length}>(${SPECIES.map(([, accent]) => linear(accent)).join(', ')});
  var patterns = array<u32, ${SPECIES.length}>(${SPECIES.map(([, , pattern]) => `${pattern}u`).join(', ')});
  let surfaceY = 3.0;
  for (var i = 0u; i < u32(fish); i = i + 1u) {
    let fi = f32(i);
    let size = 0.6 + ${hash('fi * 1.13 + 11.0')};
    let L = round(3.0 + 3.0 * size);
    let Hh = round(L * (0.4 + 0.25 * ${hash('fi * 2.71 + 13.0')}));
    let tailLength = round(L * 0.6) + 1.0;
    let span = W + 4.0 * L + 8.0;
    let pace = (5.0 + 9.0 * ${hash('fi * 3.33 + 17.0')}) / size;
    let phase = fract(time * pace / (2.0 * span) + ${hash('fi * 4.79 + 19.0')});
    let heading = select(-1.0, 1.0, phase < 0.5);
    let fx = round(-2.0 * L - 4.0 + (1.0 - abs(phase * 2.0 - 1.0)) * span);
    let laneTop = surfaceY + 4.0 + Hh;
    let laneBottom = H - sandRows - 4.0 - Hh;
    let fy = round(mix(laneTop, max(laneTop, laneBottom), ${hash('fi * 6.07 + 23.0')}) + sin(time * 0.6 + fi * 2.3) * 2.0);
    let lx = (pc.x - fx) * heading;
    let ly = pc.y - fy;
    if (abs(ly) > Hh + 3.0 || lx < -L - tailLength - 1.0 || lx > L + 1.0) {
      continue;
    }
    let species = u32(floor(${hash('fi * 7.77 + 29.0')} * ${SPECIES.length}.0)) % ${SPECIES.length}u;
    let skin = palette[species];
    let accent = accents[species];
    let e = (lx / L) * (lx / L) + (ly / Hh) * (ly / Hh);
    let outer = (lx / (L + 1.0)) * (lx / (L + 1.0)) + (ly / (Hh + 1.0)) * (ly / (Hh + 1.0));
    let behind = -lx - (L - 1.0);
    let flap = round(sin(time * 6.0 + fi * 1.9) * behind * 0.25);
    let tail = behind >= 0.0 && behind <= tailLength && abs(ly - flap) <= behind * 0.8 + 0.5;
    let finTop = ly < 0.0 && lx > -L * 0.7 && lx < L * 0.15 && (lx / L) * (lx / L) + (ly / (Hh + 1.6)) * (ly / (Hh + 1.6)) <= 1.0;
    if (e <= 1.0) {
      var c = skin;
      let pattern = patterns[species];
      if (pattern == 1u && (abs(lx - L * 0.35) < 0.9 || abs(lx + L * 0.35) < 0.9)) {
        c = accent;
      } else if (pattern == 2u && lx < -L * 0.1) {
        c = accent;
      } else if (pattern == 3u && abs(ly + 0.5) < 0.6 && lx < L * 0.6) {
        c = accent;
      }
      if (ly > Hh * 0.35) {
        c = mix(c, vec3f(1.0), 0.3);
      } else if (ly < -Hh * 0.45) {
        c = c * 0.7;
      }
      let ex = floor(L * 0.55) + 0.5;
      let ey = -floor(Hh * 0.3) - 0.5;
      if (abs(lx - ex) < 0.5 && abs(ly - ey) < 0.5) {
        c = vec3f(0.01);
      } else if (L >= 5.0 && abs(lx - ex + 1.0) < 0.5 && abs(ly - ey) < 0.5) {
        c = vec3f(0.9);
      }
      color = c;
    } else if (tail || finTop) {
      color = select(skin * 0.6, accent * 0.75, patterns[species] == 2u);
    } else if (outer <= 1.0 && lx > -L) {
      color = skin * 0.3;
    }
  }

  // Rising bubbles.
  for (var b = 0u; b < u32(bubbles); b = b + 1u) {
    let fb = f32(b);
    let bx = floor(W * (0.08 + 0.84 * ${hash('fb * 11.1 + 31.0')}));
    let bbase = ${sandTop('bx')} - 1.0;
    let height = bbase - surfaceY;
    for (var j = 0u; j < 8u; j = j + 1u) {
      let fj = f32(j);
      let rise = 8.0 + 6.0 * ${hash('fb * 13.0 + fj * 1.7 + 37.0')};
      let progress = fract(time * rise / height + fj / 8.0 + ${hash('fb * 2.9 + 39.0')});
      let center = vec2f(
        bx + round(sin(time * 2.0 + fj * 1.3 + progress * 9.0) * 1.2),
        round(bbase - progress * height),
      ) + 0.5;
      let radius = round(progress * 2.2 * (0.5 + ${hash('fj * 3.7 + fb + 43.0')}));
      let d = length(pc - center);
      if (radius < 1.0 && d < 0.5) {
        color = mix(color, vec3f(0.85, 0.95, 1.0), 0.7);
      } else if (radius >= 1.0 && abs(d - radius) < 0.5) {
        color = mix(color, vec3f(0.85, 0.95, 1.0), 0.6);
      } else if (radius >= 2.0 && all(pc - center == vec2f(-1.0, -1.0))) {
        color = vec3f(1.0);
      }
    }
  }

  // The water's surface.
  let wave = surfaceY + round(sin(pc.x * 0.21 + time * 1.4) * 0.8 + sin(pc.x * 0.09 - time * 0.9) * 0.7);
  if (cell.y < wave) {
    color = mix(waterTop.rgb, vec3f(0.75, 0.9, 1.0), 0.15);
  } else if (cell.y == wave) {
    color = mix(waterTop.rgb, vec3f(0.9, 0.97, 1.0), 0.45);
  }

  return vec4f(color, 1.0);
`;

export const componentDefinition = defineShader({
  name: 'Aquarium',
  category: 'Textures',
  description: 'Pixel-art fish tank with swimming fish, swaying plants, and bubbles',
  animatedTime: { speed: 'speed' },
  props: {
    speed: {
      default: 1,
      description: 'Animation speed',
      ui: { type: 'range', min: 0, max: 3, step: 0.1, label: 'Speed' },
    },
    pixelSize: {
      default: 6,
      description: 'Size of one art pixel in screen pixels',
      ui: { type: 'range', min: 2, max: 16, step: 1, label: 'Pixel Size' },
    },
    fish: {
      default: 9,
      description: 'Number of fish',
      ui: { type: 'range', min: 0, max: 30, step: 1, label: 'Fish' },
    },
    plants: {
      default: 12,
      description: 'Number of plants',
      ui: { type: 'range', min: 0, max: 30, step: 1, label: 'Plants' },
    },
    bubbles: {
      default: 2,
      description: 'Number of bubble streams',
      ui: { type: 'range', min: 0, max: 6, step: 1, label: 'Bubbles' },
    },
    seed: {
      default: 0,
      description: 'Random seed for variation',
      ui: { type: 'range', min: 0, max: 100, step: 1, label: 'Seed' },
    },
    waterTop: {
      default: '#2a86b8',
      transform: transformColor,
      description: 'Water color near the surface',
      ui: { type: 'color', label: 'Water Top' },
    },
    waterBottom: {
      default: '#0a2342',
      transform: transformColor,
      description: 'Water color near the floor',
      ui: { type: 'color', label: 'Water Bottom' },
    },
    sand: {
      default: '#c8a46a',
      transform: transformColor,
      description: 'Sand color',
      ui: { type: 'color', label: 'Sand' },
    },
    plant: {
      default: '#2f9a4c',
      transform: transformColor,
      description: 'Plant color',
      ui: { type: 'color', label: 'Plant' },
    },
  },
  paint: wgsl({ body, inputs: { screen: ctx.logicalViewportSize } }),
});

export default componentDefinition;
