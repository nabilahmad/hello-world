import { type Page, expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const sample = (name: string) => fileURLToPath(new URL(`../samples/${name}`, import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url));

async function open(page: Page, ...files: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#btn-open').click();
  await (await chooser).setFiles(files);
  await page.waitForFunction(() => {
    const app = (window as any).__dxfApp;
    return app?.viewer?.doc?.view && document.querySelector('#loading')?.hasAttribute('hidden');
  });
}

/** Page coordinates of a drawing (world) point in the active tab. */
async function screenOf(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([X, Y]) => {
    const v = (window as any).__dxfApp.viewer;
    const [ox, oy] = v.doc.model.origin;
    const [sx, sy] = v.toScreen(X - ox, Y - oy);
    const r = document.querySelector('#stage')!.getBoundingClientRect();
    return [r.left + sx, r.top + sy] as [number, number];
  }, [x, y]);
}

async function hover(page: Page, x: number, y: number) {
  const [px, py] = await screenOf(page, x, y);
  await page.mouse.move(px, py);
  const tip = page.locator('.tooltip');
  await expect(tip).toBeVisible();
  return tip;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  (page as any).errors = errors;
  await page.goto('/');
});

test.afterEach(async ({ page }) => {
  expect((page as any).errors).toEqual([]);
});

test('shows the empty state until a file is opened', async ({ page }) => {
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty h1')).toHaveText('Open a DXF drawing');
});

test('reports the cardinal bounding box of the geometry', async ({ page }) => {
  await open(page, sample('plate-mm.dxf'));
  await expect(page.locator('#st-extents')).toHaveText('200 mm × 120 mm');
  await expect(page).toHaveTitle('plate-mm.dxf — DXF Viewer');
  // Including text and dimensions grows the box.
  await page.locator('#chk-annot').check();
  await expect(page.locator('#st-extents')).not.toHaveText('200 mm × 120 mm');
});

test('measures a polyline segment on hover', async ({ page }) => {
  await open(page, sample('plate-mm.dxf'));
  const tip = await hover(page, 100, 0);
  await expect(tip.locator('.tt-title')).toHaveText('Polyline · line 1 of 8');
  await expect(tip).toContainText('Length180 mm');
  await expect(tip).toContainText('Perimeter622.83 mm');
});

test('measures arcs and circles on hover', async ({ page }) => {
  await open(page, sample('plate-mm.dxf'));
  const r = Math.SQRT1_2 * 10;
  let tip = await hover(page, 190 + r, 110 + r);
  await expect(tip.locator('.tt-title')).toHaveText('Polyline · arc 4 of 8');
  await expect(tip).toContainText('Radius10 mm');
  await expect(tip).toContainText('Arc length15.71 mm');
  await expect(tip).toContainText('Included angle90°');
  tip = await hover(page, 16, 20);
  await expect(tip.locator('.tt-title')).toHaveText('Circle');
  await expect(tip).toContainText('Diameter8 mm');
  await expect(tip).toContainText('Center20, 20');
});

test('converts units and precision', async ({ page }) => {
  await open(page, sample('plate-mm.dxf'));
  await page.locator('#sel-units').selectOption('1');
  await expect(page.locator('#st-extents')).toHaveText('7.87 in × 4.72 in');
  await page.locator('#sel-prec').selectOption('4');
  await expect(page.locator('#st-extents')).toHaveText('7.874 in × 4.7244 in');
});

test('layer visibility changes the measured box', async ({ page }) => {
  await open(page, sample('plate-mm.dxf'));
  await page.keyboard.press('l');
  const panel = page.locator('#layers-panel');
  await expect(panel).toBeVisible();
  await panel.locator('.layer-row', { hasText: 'OUTLINE' }).locator('input').uncheck();
  await expect(page.locator('#st-extents')).not.toHaveText('200 mm × 120 mm');
  await panel.locator('.layer-row', { hasText: 'OUTLINE' }).locator('input').check();
  await expect(page.locator('#st-extents')).toHaveText('200 mm × 120 mm');
});

test('opens several files as tabs and closes them', async ({ page }) => {
  await open(page, sample('plate-mm.dxf'), sample('bracket-r12.dxf'), fixture('plate-bin.dxf'));
  const tabs = page.locator('#tabs .tab');
  await expect(tabs).toHaveCount(3);
  await tabs.filter({ hasText: 'bracket-r12.dxf' }).click();
  await expect(page.locator('#st-extents')).toHaveText('4 × 3');
  await tabs.filter({ hasText: 'plate-bin.dxf' }).click();
  await expect(page.locator('#st-extents')).toHaveText('200 mm × 120 mm');
  await page.keyboard.press('Control+w');
  await expect(tabs).toHaveCount(2);
  await tabs.first().locator('.tab-close').click();
  await expect(tabs).toHaveCount(1);
});

test('toggles the dimension overlay and fits the view', async ({ page }) => {
  await open(page, sample('plate-mm.dxf'));
  const dims = page.locator('#btn-dims');
  await expect(dims).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('d');
  await expect(dims).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, -500);
  await expect(page.locator('#st-zoom')).not.toHaveText('100%');
  await page.keyboard.press('f');
  await expect(page.locator('#st-zoom')).toHaveText('100%');
});

test('reorders tabs by dragging', async ({ page }) => {
  await open(page, sample('plate-mm.dxf'), sample('bracket-r12.dxf'), fixture('plate-bin.dxf'));
  const names = () => page.locator('#tabs .tab .tab-name').allTextContents();
  expect(await names()).toEqual(['plate-mm.dxf', 'bracket-r12.dxf', 'plate-bin.dxf']);
  const first = await page.locator('#tabs .tab').first().boundingBox();
  const last = await page.locator('#tabs .tab').last().boundingBox();
  await page.mouse.move(first!.x + 20, first!.y + first!.height / 2);
  await page.mouse.down();
  await page.mouse.move(last!.x + last!.width - 10, first!.y + first!.height / 2, { steps: 12 });
  await page.mouse.up();
  expect(await names()).toEqual(['bracket-r12.dxf', 'plate-bin.dxf', 'plate-mm.dxf']);
  await expect(page.locator('#tabs .tab.active .tab-name')).toHaveText('plate-mm.dxf');
});
