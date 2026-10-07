import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

/** Reject symlinks/junctions at every existing component inside the root. */
export async function assertLocalPath(root: string, path: string): Promise<void> {
  const base = resolve(root);
  const target = resolve(path);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('UNSAFE_PATH');
  let component = base;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) component = resolve(component, part);
    const info = await lstat(component).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (info?.isSymbolicLink()) throw new Error('UNSAFE_PATH');
    if (info !== null) {
      const resolved = await realpath(component);
      const inside = relative(await realpath(base), resolved);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        throw new Error('UNSAFE_PATH');
    }
  }
}
