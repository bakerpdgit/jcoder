import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'

/**
 * These run against `dist/`, served by server.mjs.
 *
 * The first three cover the things that must never regress whether or not the
 * TeaVM bundle has been downloaded: the shell loads, the page is cross-origin
 * isolated (without which input cannot block), and a missing bundle produces a
 * readable instruction rather than a white screen.
 *
 * The rest only run when `public/teavm/` is present, so CI without the bundle
 * still gets a useful signal.
 */

function collectProblems(page: Page) {
  const problems: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  return problems
}

/** Console/page errors that are expected when the runtime bundle is absent. */
const EXPECTED = [
  /compiler\.wasm/i,
  /404/,
  /Failed to load resource/i,
  /runtime bundle/i,
  /fetch:runtime/i,
]

async function runtimeIsPresent(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const response = await fetch('/teavm/compiler.wasm', { method: 'HEAD' })
    return response.ok
  })
}

/** The toolchain downloads several megabytes before the first run is possible. */
async function waitForReady(page: Page) {
  await expect(page.getByText('ready', { exact: true })).toBeVisible({ timeout: 120_000 })
}

test('the IDE shell loads and shows the Java starter file', async ({ page }) => {
  const problems = collectProblems(page)
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /Coder/ })).toBeVisible()
  await expect(page.getByText('/Main.java').first()).toBeVisible({ timeout: 20_000 })

  // Monaco mounted and has the template in it.
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.view-lines')).toContainText('public class Main', { timeout: 20_000 })

  const unexpected = problems.filter(p => !EXPECTED.some(re => re.test(p)))
  expect(unexpected, `unexpected console output:\n${unexpected.join('\n')}`).toEqual([])
})

test('the page is cross-origin isolated, so input can block', async ({ page }) => {
  await page.goto('/')
  // Without this, SharedArrayBuffer is unavailable, the worker cannot park on
  // Atomics.wait, and typed input silently stops working.
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true)
  expect(await page.evaluate(() => typeof SharedArrayBuffer !== 'undefined')).toBe(true)
})

test('the About dialog explains the limitations and links to the licences', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: /^About/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('About A Java Coder')).toBeVisible()

  // The limitations are the reason the dialog exists.
  await expect(dialog.getByText(/built-in Scanner/)).toBeVisible()
  await expect(dialog.getByText(/Annotations with brackets/)).toBeVisible()

  // Both licence texts must actually be served, not just linked.
  for (const path of ['/third-party-notices.txt', '/monaco-third-party-notices.txt']) {
    const response = await page.request.get(path)
    expect(response.status(), `${path} should be served`).toBe(200)
    expect((await response.text()).length).toBeGreaterThan(500)
  }

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})

test('a missing runtime bundle is explained rather than silently failing', async ({ page }) => {
  await page.goto('/')
  test.skip(await runtimeIsPresent(page), 'the TeaVM bundle is present, so this path cannot be exercised')

  await expect(page.getByText(/fetch:runtime/)).toBeVisible({ timeout: 60_000 })
})

test('compiles and runs a program, reading input typed into the console', async ({ page }) => {
  await page.goto('/')
  test.skip(!(await runtimeIsPresent(page)), 'needs public/teavm — run `npm run fetch:runtime`')

  await waitForReady(page)
  await page.getByTitle(/^Run/).click()

  // The starter program prompts, then blocks: the prompt must be on screen
  // before the caret appears, and the caret lives inside the console output.
  await expect(page.getByText('What is your name?')).toBeVisible({ timeout: 120_000 })
  const caret = page.getByLabel('Console input line')
  await expect(caret).toBeFocused()

  await caret.fill('Ada')
  await caret.press('Enter')

  await expect(page.getByText('Hello, Ada!')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('exited with code 0')).toBeVisible()
})

test('answers input from the Inputs tab without prompting, and runs twice', async ({ page }) => {
  await page.goto('/')
  test.skip(!(await runtimeIsPresent(page)), 'needs public/teavm — run `npm run fetch:runtime`')

  await waitForReady(page)
  await page.getByRole('button', { name: /^Inputs/ }).click()
  await page.getByLabel('Program input').fill('Grace')

  await page.getByTitle(/^Run/).click()
  await expect(page.getByText('Hello, Grace!')).toBeVisible({ timeout: 120_000 })

  // A second run must work too: a compiler cannot be reused after generating
  // WebAssembly, so each run gets a fresh one. This is the regression guard.
  await page.getByRole('button', { name: /^Inputs/ }).click()
  await page.getByLabel('Program input').fill('Alan')
  await page.getByTitle(/^Run/).click()
  await expect(page.getByText('Hello, Alan!')).toBeVisible({ timeout: 120_000 })
})

test('reports compiler errors in the Problems tab', async ({ page }) => {
  await page.goto('/')
  test.skip(!(await runtimeIsPresent(page)), 'needs public/teavm — run `npm run fetch:runtime`')

  await waitForReady(page)
  await page.locator('.view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('public class Main { public static void main(String[] a) { int x = "no"; } }')

  await page.getByTitle(/^Run/).click()

  await expect(page.getByText(/incompatible types/)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/Main\.java:1:/)).toBeVisible()
})
