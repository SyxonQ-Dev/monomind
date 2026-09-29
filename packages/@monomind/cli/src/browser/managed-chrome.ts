/**
 * A Chrome for `monomind browse` on a machine that has none (#428).
 *
 * monobrowse drives an installed Chrome, Chromium or Edge and always prefers
 * one. Only when it finds none does it ask the fallback registered here, which
 * downloads Chrome for Testing once into `~/.monomind/deps/chrome@<build>/`
 * with @puppeteer/browsers (the downloader puppeteer's own postinstall uses,
 * itself installed on first use by ensureOptionalDependency). Before #428,
 * every install fetched that Chrome up front through puppeteer's postinstall.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  autoInstallDisabled,
  depsRoot,
  ensureOptionalDependency,
  installOnce,
  NO_AUTO_INSTALL_ENV,
  OPTIONAL_DEPENDENCIES,
  OptionalDependencyError,
} from '../utils/optional-deps.js';

/** The Chrome build puppeteer 25.3.0 pins (puppeteer-core's revisions.ts). */
export const CHROME_BUILD_ID = '150.0.7871.24';

/** The part of @puppeteer/browsers this module uses. */
export interface BrowsersModule {
  Browser: { CHROME: string };
  detectBrowserPlatform(): string | undefined;
  computeExecutablePath(o: {
    browser: string;
    buildId: string;
    cacheDir: string;
    platform?: string;
  }): string;
  install(o: {
    browser: string;
    buildId: string;
    cacheDir: string;
    platform?: string;
    downloadProgressCallback?: (downloaded: number, total: number) => void;
  }): Promise<unknown>;
}

export interface ManagedChromeOptions {
  env?: NodeJS.ProcessEnv;
  loadBrowsers?: () => Promise<BrowsersModule>;
  log?: (line: string) => void;
}

export function managedChromeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(depsRoot(env), `chrome@${CHROME_BUILD_ID}`);
}

/** Path of monomind's own Chrome, downloading it first if needed. */
export async function ensureManagedChrome(opts: ManagedChromeOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(`[monomind] ${line}\n`));
  const dir = managedChromeDir(env);
  const browsers = await (
    opts.loadBrowsers ??
    (() => ensureOptionalDependency<BrowsersModule>('@puppeteer/browsers', { env, log }))
  )();
  const platform = browsers.detectBrowserPlatform();
  if (!platform) {
    throw new OptionalDependencyError(
      'No Chrome, Chromium or Edge is installed, and Chrome for Testing has no build for this ' +
        'platform. Install a browser to use `monomind browse`.',
    );
  }
  const where = { browser: browsers.Browser.CHROME, buildId: CHROME_BUILD_ID, platform };
  const executable = browsers.computeExecutablePath({ ...where, cacheDir: dir });
  if (existsSync(executable)) return executable;

  if (autoInstallDisabled(env)) {
    const version = OPTIONAL_DEPENDENCIES['@puppeteer/browsers'].version;
    throw new OptionalDependencyError(
      `No Chrome, Chromium or Edge is installed, and ${NO_AUTO_INSTALL_ENV} is set, so monomind ` +
        'will not download one. Install a browser, or fetch the Chrome monomind uses with:\n' +
        `  npx @puppeteer/browsers@${version} install chrome@${CHROME_BUILD_ID} --path "${dir}"`,
    );
  }

  log(
    `No Chrome, Chromium or Edge is installed. Downloading Chrome ${CHROME_BUILD_ID} ` +
      `(about 400 MB on disk) once into ${dir} (set ${NO_AUTO_INSTALL_ENV}=1 to prevent this)...`,
  );
  await installOnce(
    dir,
    (d) => existsSync(browsers.computeExecutablePath({ ...where, cacheDir: d })),
    async (staging) => {
      let lastTenth = -1;
      await browsers.install({
        ...where,
        cacheDir: staging,
        downloadProgressCallback: (done, total) => {
          const tenth = total > 0 ? Math.floor((done / total) * 10) : -1;
          if (tenth > lastTenth) {
            lastTenth = tenth;
            log(`Chrome download ${tenth * 10}%`);
          }
        },
      });
    },
    log,
  );
  log(`Chrome is ready at ${executable}.`);
  return executable;
}
