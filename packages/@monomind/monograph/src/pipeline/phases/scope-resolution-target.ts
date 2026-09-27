import type { CallSite } from './call-site-extractors.js';

// Split out of scope-resolution.ts (file-size sweep). Pure move: no behaviour change.

// ── Target resolution ────────────────────────────────────────────────────────

export function pickBestId(ids: string[], site: CallSite): string | null {
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) return null;
  const suffix = site.form === 'method' ? '_method' : '_function';
  const match = ids.find((id) => id.endsWith(suffix));
  if (!match && site.calleeRaw.startsWith('new ')) {
    const classMatch = ids.find((id) => id.endsWith('_class'));
    if (classMatch) return classMatch;
  }
  return match ?? ids[0];
}

export function resolveTarget(
  site: CallSite,
  callerFilePath: string,
  importMap: Map<string, string>,
  fnIndex: Map<string, Map<string, string[]>>,
  ctorMap: Map<string, string> | undefined,
  importedFiles: string[],
): { targetId: string } | null {
  const methodName = site.methodName;
  if (!methodName) return null;

  let candidateFilePaths: string[];

  if (site.form === 'method' && site.receiverName) {
    const receiverPath = importMap.get(site.receiverName);
    if (receiverPath) {
      candidateFilePaths = [receiverPath];
    } else {
      const className = ctorMap?.get(site.receiverName);
      const classFilePath = className ? importMap.get(className) : undefined;
      if (classFilePath) {
        candidateFilePaths = [classFilePath, callerFilePath];
      } else {
        const sameFileIds = fnIndex.get(callerFilePath)?.get(methodName);
        if (sameFileIds && sameFileIds.length > 0) {
          return { targetId: pickBestId(sameFileIds, site)! };
        }
        const matches = importedFiles.filter((fp) => fnIndex.get(fp)?.has(methodName));
        if (matches.length === 1) {
          const ids = fnIndex.get(matches[0])?.get(methodName)!;
          return { targetId: pickBestId(ids, site)! };
        }
        return null;
      }
    }
  } else if (site.form === 'direct') {
    const importedFrom = importMap.get(methodName);
    if (importedFrom) {
      candidateFilePaths = [importedFrom, callerFilePath];
    } else {
      candidateFilePaths = [callerFilePath, ...importedFiles];
    }
  } else {
    return null;
  }

  for (const fp of candidateFilePaths) {
    const ids = fnIndex.get(fp)?.get(methodName);
    if (ids && ids.length > 0) {
      const best = pickBestId(ids, site);
      if (best) return { targetId: best };
    }
  }

  return null;
}
