import { createRequire } from 'node:module';
import path from 'node:path';

// Split out of cap-documents.ts (file-size sweep). Pure move: no behaviour change.

export type XlsxModule = {
  readFile(
    filePath: string,
    options: { type: 'file' },
  ): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_csv(sheet: unknown, options: { FS: string; blankrows: boolean }): string;
  };
};

/**
 * Load SheetJS from the CLI installation first, then from the initialized
 * project. The second location lets an `npx monomind` user opt into
 * spreadsheet extraction without modifying the npx cache.
 */
export function requireXlsx(): XlsxModule {
  const requireFromCli = createRequire(import.meta.url);
  try {
    return requireFromCli('xlsx') as XlsxModule;
  } catch {
    return createRequire(path.join(process.cwd(), 'package.json'))('xlsx') as XlsxModule;
  }
}
