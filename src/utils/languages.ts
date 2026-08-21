import type { LanguageDef, LanguageId } from '../types'

const JAVA_TEMPLATE = `public class Main {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);

        System.out.print("What is your name? ");
        String name = input.nextLine();
        System.out.println("Hello, " + name + "!");
    }
}
`

/**
 * The language registry.
 *
 * jcoder compiles one language, but the registry is kept because the whole app
 * — the filesystem, the editor, the Problems tab — is written against it rather
 * than against hard-coded ".java", which is what makes adding Kotlin (also a
 * JVM language TeaVM can consume) a change in one place.
 */
export const LANGUAGES: Record<LanguageId, LanguageDef> = {
  java: {
    id: 'java',
    label: 'Java',
    monacoId: 'java',
    extension: '.java',
    defaultFileName: 'Main.java',
    template: JAVA_TEMPLATE,
  },
}

export const LANGUAGE_ORDER: LanguageId[] = ['java']

export const LANGUAGE_LIST: LanguageDef[] = LANGUAGE_ORDER.map(id => LANGUAGES[id])

export const DEFAULT_LANGUAGE: LanguageId = 'java'

export function isLanguageId(value: string): value is LanguageId {
  return value in LANGUAGES
}

export function getLanguage(id: LanguageId): LanguageDef {
  return LANGUAGES[id]
}

/** Extensions whose files are handed to the compiler for `id`. */
export function compileExtensions(id: LanguageId): string[] {
  const lang = LANGUAGES[id]
  return [lang.extension, ...(lang.alsoCompile ?? [])]
}

/** The language a filename belongs to, or null if it is not a source file. */
export function languageForFile(name: string): LanguageId | null {
  const lower = name.toLowerCase()
  for (const id of LANGUAGE_ORDER) {
    for (const ext of compileExtensions(id)) {
      if (lower.endsWith(ext)) return id
    }
  }
  return null
}

/**
 * Monaco language id for a filename — used when a non-source file (README.md,
 * data.json, …) is opened in the editor so it still gets sensible highlighting.
 */
export function monacoLanguageForFile(name: string): string {
  const byLang = languageForFile(name)
  if (byLang) return LANGUAGES[byLang].monacoId
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    json: 'json', md: 'markdown', txt: 'plaintext', csv: 'plaintext',
    xml: 'xml', html: 'html', htm: 'html', properties: 'plaintext',
    css: 'css', js: 'javascript', ts: 'typescript', yml: 'yaml', yaml: 'yaml',
    sql: 'sql', gradle: 'plaintext', kt: 'java',
  }
  return map[ext] ?? 'plaintext'
}
