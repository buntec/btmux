import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  channel: process.env.BTMUX_TEST_BROWSER,
  args: ['--enable-unsafe-webgpu'],
});
try {
  const page = await browser.newPage();
  await page.goto(process.env.BTMUX_TEST_URL ?? 'http://localhost:5173');
  const available = await page.evaluate(async () => !!(await (navigator as any).gpu?.requestAdapter()));
  if (available) {
    const results = await page.evaluate(async () => {
      const { createWallpaperRenderer } = await import('/src/lib/wallpaperRenderer.ts' as string);
      const { createShaderLayer } = await import('/src/lib/wallpaperCatalog.ts' as string);
      const { WALLPAPER_SHADER_LOADERS } = await import('/src/generated/wallpaperShaderLoaders.ts' as string);
      await Promise.all([WALLPAPER_SHADER_LOADERS.checkerboard(), WALLPAPER_SHADER_LOADERS.invert()]);
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px';
      document.body.append(canvas);
      const options = {
        layers: [createShaderLayer('checkerboard')],
        speed: 1,
        fps: 20,
        resolution: 0.5,
        animated: false,
        paused: false,
        followsMouseCursor: false,
        followsKeyboardInput: false,
      };
      let unavailable = false;
      const renderer = createWallpaperRenderer(canvas, options, () => (unavailable = true));
      const gpu = (navigator as any).gpu;
      const requestAdapter = gpu.requestAdapter.bind(gpu);
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const adapterStarted = new Promise<void>((resolve) => (started = resolve));
      gpu.requestAdapter = async (...args: unknown[]) => {
        started();
        await gate;
        return requestAdapter(...args);
      };
      let startupAlpha = 0;
      try {
        const initialization = renderer.initialize();
        await adapterStarted;
        renderer.update({ ...options, layers: [createShaderLayer('invert')] });
        // Let the update run while core registrations are still queued.
        await sleep(100);
        release();
        await initialization;
        await sleep(200);
        const image = new Image();
        image.src = canvas.toDataURL();
        await image.decode();
        const copy = document.createElement('canvas');
        copy.width = image.width;
        copy.height = image.height;
        const context = copy.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
        for (let i = 3; i < pixels.length; i += 4) startupAlpha += pixels[i];
      } finally {
        release();
        gpu.requestAdapter = requestAdapter;
        renderer.dispose();
      }

      const weave = createWallpaperRenderer(
        canvas,
        {
          ...options,
          animated: true,
          layers: [createShaderLayer('checkerboard'), { ...createShaderLayer('film-stock'), params: { weave: 1 } }],
        },
        () => (unavailable = true),
      );
      let weaveChanged = false;
      try {
        await weave.initialize();
        await sleep(500);
        const before = canvas.toDataURL();
        for (let i = 0; i < 30 && !weaveChanged; i++) {
          await sleep(100);
          weaveChanged = canvas.toDataURL() !== before;
        }
      } finally {
        weave.dispose();
        canvas.remove();
      }
      return { unavailable, startupAlpha, weaveChanged };
    });
    assert(!results.unavailable, 'the lifecycle test renderers must initialize');
    assert.equal(results.startupAlpha, 0, 'the removed Checkerboard must not remain beneath Invert after startup');
    assert(results.weaveChanged, 'Film Stock Gate Weave must animate over a static generator');
    console.log('PASS shader changes during GPU initialization and callback-driven animation');
  } else console.log('SKIP shader lifecycle checks: the test browser has no usable WebGPU adapter');
} finally {
  await browser.close();
}
