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

test('reads and writes the files in the editor', async ({ page }) => {
  await page.goto('/')
  test.skip(!(await runtimeIsPresent(page)), 'needs public/teavm — run `npm run fetch:runtime`')

  await waitForReady(page)

  // A data file for the program to open.
  await page.getByLabel('New file').click()
  await page.getByRole('dialog').getByRole('textbox').fill('notes.txt')
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  // Creating a file lists it; opening it is a separate click.
  await page.getByRole('button', { name: 'notes.txt' }).click()
  await expect(page.getByText('/notes.txt').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('.view-lines').click()
  await page.keyboard.type('one\ntwo')

  // Back to the program, which reads that file and writes another.
  await page.getByRole('button', { name: 'Main.java' }).click()
  await page.locator('.view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(
    'import java.io.*; import java.nio.file.*; import java.util.*; '
    + 'public class Main { public static void main(String[] a) throws Exception { '
    + 'List<String> lines = Files.readAllLines(Paths.get("notes.txt")); '
    + 'PrintWriter out = new PrintWriter("out/loud.txt"); '
    + 'for (String s : lines) { System.out.println("read " + s); out.println(s.toUpperCase()); } '
    + 'out.close(); '
    + 'System.out.println("check " + Files.readString(Paths.get("out/loud.txt")).trim()); } }')

  await page.getByTitle(/^Run/).click()

  await expect(page.getByText('read one')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/check ONE/)).toBeVisible()
  await expect(page.getByText('exited with code 0')).toBeVisible()

  // The folder the program created shows up in the sidebar.
  await expect(page.getByRole('button', { name: /out/ }).first()).toBeVisible({ timeout: 20_000 })
})

test('adds an example, pins it as the class to run, and runs it', async ({ page }) => {
  await page.goto('/')
  test.skip(!(await runtimeIsPresent(page)), 'needs public/teavm — run `npm run fetch:runtime`')

  await waitForReady(page)
  const examples = page.getByRole('combobox', { name: 'Examples' })
  await examples.selectOption('ex3')

  // The file is written, opened, and set as the class Run will use.
  await expect(page.getByText('/Example3.java').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('combobox', { name: 'Main' })).toHaveValue('Example3')

  await page.getByTitle(/^Run/).click()
  await expect(page.getByText('Array holds 4 numbers')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('exited with code 0')).toBeVisible()

  // Adding it a second time asks before replacing.
  await examples.selectOption('ex3')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/already exists/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})

test('asks how a folder should be connected before opening the picker', async ({ page }) => {
  await page.goto('/')

  // If the picker were reached, this would record it. Cancelling must not.
  await page.evaluate(() => {
    ;(window as unknown as { __pickerCalled?: boolean }).__pickerCalled = false
    ;(window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      ;(window as unknown as { __pickerCalled?: boolean }).__pickerCalled = true
      throw Object.assign(new Error('stub'), { name: 'AbortError' })
    }
  })

  await page.getByRole('button', { name: 'Default' }).first().click()
  await page.getByRole('button', { name: /Connect a folder/ }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: /Two-way link/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /One-way import/ })).toBeVisible()
  // The consequence of a two-way link has to be stated, not implied.
  await expect(dialog.getByText(/writes to the real folder/)).toBeVisible()

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => (window as unknown as { __pickerCalled?: boolean }).__pickerCalled))
    .toBe(false)
})

test('reads and writes binary files byte for byte', async ({ page }) => {
  await page.goto('/')
  test.skip(!(await runtimeIsPresent(page)), 'needs public/teavm — run `npm run fetch:runtime`')

  await waitForReady(page)
  await page.locator('.view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  // Writes every byte value, reads them back, and checks the round trip —
  // including through TeaVM's own DataOutputStream, which wraps ours.
  await page.keyboard.type(
    'import java.io.*; public class Main { public static void main(String[] a) throws Exception { '
    + 'FileOutputStream out = new FileOutputStream("bytes.bin"); '
    + 'for (int i = 0; i < 256; i++) out.write(i); out.close(); '
    + 'FileInputStream in = new FileInputStream("bytes.bin"); '
    + 'int bad = -1; for (int i = 0; i < 256; i++) { if (in.read() != i) { bad = i; break; } } in.close(); '
    + 'System.out.println("roundtrip " + (bad < 0 ? "exact" : "broken at " + bad)); '
    + 'System.out.println("size " + new File("bytes.bin").length()); '
    + 'DataOutputStream d = new DataOutputStream(new FileOutputStream("n.bin")); '
    + 'd.writeInt(123456789); d.close(); '
    + 'DataInputStream r = new DataInputStream(new FileInputStream("n.bin")); '
    + 'System.out.println("int " + r.readInt()); r.close(); } }')

  await page.getByTitle(/^Run/).click()

  await expect(page.getByText('roundtrip exact')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('size 256')).toBeVisible()
  await expect(page.getByText('int 123456789')).toBeVisible()
  await expect(page.getByText('exited with code 0')).toBeVisible()
})

test('e.getMessage() works, despite the class library not offering it', async ({ page }) => {
  await page.goto('/')
  test.skip(!(await runtimeIsPresent(page)), 'needs public/teavm — run `npm run fetch:runtime`')

  await waitForReady(page)
  await page.locator('.view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(
    'public class Main { public static void main(String[] a) { '
    + 'try { throw new java.io.IOException("bad file"); } '
    + 'catch (java.io.IOException e) { System.out.println("caught: " + e.getMessage()); } } }')

  await page.getByTitle(/^Run/).click()

  await expect(page.getByText('caught: bad file')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('exited with code 0')).toBeVisible()
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
