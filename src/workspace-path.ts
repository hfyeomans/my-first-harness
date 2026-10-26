import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_BYTES = 200_000;

export type PathFailure = { ok: false; error: string; missing: boolean };

type Located = { ok: true; root: string; full: string } | { ok: false; error: string };

/** Open an existing file that stays inside `cwd`, or a path error. Caller closes the handle. */
export async function openInside(
  rel: string,
  cwd: string,
  flags: string | number,
): Promise<{ ok: true; handle: FileHandle; realPath: string } | PathFailure> {
  const located = locate(rel, cwd);
  if (!located.ok) return { ok: false, error: located.error, missing: false };

  const root = await realRootOf(located.root, rel);
  if (!root.ok) return root;

  let handle: FileHandle;
  try {
    handle = await open(located.full, flags);
  } catch (err) {
    if (isEnoent(err)) return { ok: false, error: `No such file: ${rel}`, missing: true };
    if (isEisdir(err)) return { ok: false, error: `${rel} is not a file.`, missing: false };
    return { ok: false, error: errorText(err), missing: false };
  }

  let opened: string;
  try {
    opened = await locationOf(handle, located.full);
  } catch (err) {
    await handle.close();
    return { ok: false, error: errorText(err), missing: false };
  }

  // Check the descriptor we opened, then use that same descriptor. realpath() on the
  // name and a later read or write are two lookups: a directory swapped for a symlink
  // in between would land outside cwd.
  if (escapes(root.realRoot, opened)) {
    await handle.close();
    return { ok: false, error: "Path escapes the working directory.", missing: false };
  }
  return { ok: true, handle, realPath: opened };
}

/**
 * Write `content` inside `cwd`. An existing file is replaced only after the new
 * bytes are synced in the same directory. `beforeRename` runs after that sync
 * and before the rename; a returned string aborts and deletes the temporary file.
 */
export async function commitInside(
  rel: string,
  cwd: string,
  content: string,
  beforeRename?: () => Promise<string | undefined>,
): Promise<{ ok: true } | PathFailure> {
  const located = locate(rel, cwd);
  if (!located.ok) return { ok: false, error: located.error, missing: false };

  const opened = await openInside(rel, cwd, constants.O_WRONLY);
  if (opened.ok) {
    try {
      const info = await opened.handle.stat();
      if (!info.isFile()) return { ok: false, error: `${rel} is not a file.`, missing: false };
    } catch (err) {
      return { ok: false, error: errorText(err), missing: false };
    } finally {
      await opened.handle.close();
    }
    return commitInDir(
      path.dirname(opened.realPath),
      path.basename(opened.realPath),
      content,
      cwd,
      beforeRename,
      ".",
      true,
      rel,
    );
  }
  if (!opened.missing) return opened;

  // open followed the last component. A dangling symlink is ENOENT there, but the
  // name itself exists; renaming onto it would replace the symlink.
  try {
    const existing = await lstat(located.full);
    if (existing.isSymbolicLink()) {
      return { ok: false, error: `Refusing to write through a symlink at ${rel}.`, missing: false };
    }
    return { ok: false, error: `Cannot create ${rel}: the path already exists.`, missing: false };
  } catch (err) {
    if (!isEnoent(err)) return { ok: false, error: errorText(err), missing: false };
  }

  return commitInDir(
    path.dirname(located.full),
    path.basename(located.full),
    content,
    cwd,
    beforeRename,
    parentLabel(located.root, located.full),
    false,
    rel,
  );
}

async function commitInDir(
  dir: string,
  name: string,
  content: string,
  cwd: string,
  beforeRename: (() => Promise<string | undefined>) | undefined,
  missingDirLabel: string,
  replace: boolean,
  rel: string,
): Promise<{ ok: true } | PathFailure> {
  let realRoot: string;
  try {
    realRoot = await realpath(path.resolve(cwd));
  } catch (err) {
    if (isEnoent(err)) return { ok: false, error: `No such directory: ${missingDirLabel}`, missing: true };
    return { ok: false, error: errorText(err), missing: false };
  }

  let parent: FileHandle;
  try {
    parent = await open(dir, "r");
  } catch (err) {
    if (isEnoent(err)) return { ok: false, error: `No such directory: ${missingDirLabel}`, missing: true };
    if (isEnotdir(err)) return { ok: false, error: `${missingDirLabel} is not a directory.`, missing: false };
    return { ok: false, error: errorText(err), missing: false };
  }

  const tmpName = `.myagent-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  let tmpPath = "";
  let tmp: FileHandle | undefined;
  try {
    const parentReal = await locationOf(parent, dir);
    if (escapes(realRoot, parentReal) || escapes(realRoot, path.join(parentReal, name))) {
      return { ok: false, error: "Path escapes the working directory.", missing: false };
    }

    // Create through the directory fd we just checked. O_NOFOLLOW refuses a
    // symlink as the temporary name. The original is untouched until rename.
    tmpPath = fdPath(parent, parentReal, tmpName);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    tmp = await open(tmpPath, flags, 0o666);
    await tmp.writeFile(content);
    await tmp.sync();
    await tmp.close();
    tmp = undefined;

    if (beforeRename) {
      const problem = await beforeRename();
      if (problem) {
        await unlinkQuiet(tmpPath);
        tmpPath = "";
        return { ok: false, error: problem, missing: false };
      }
    }

    const dest = fdPath(parent, parentReal, name);
    if (replace) {
      await rename(tmpPath, dest);
    } else {
      // link fails if the name appeared after the missing-file check, so a
      // create does not clobber that file. rename would.
      await link(tmpPath, dest);
      await unlinkQuiet(tmpPath);
    }
    tmpPath = "";
    return { ok: true };
  } catch (err) {
    if (tmp) await tmp.close().catch(() => {});
    if (tmpPath) await unlinkQuiet(tmpPath);
    if (!replace && codeIs(err, "EEXIST")) {
      return { ok: false, error: `Cannot create ${rel}: the path already exists.`, missing: false };
    }
    if (!replace && codeIs(err, "ELOOP")) {
      return { ok: false, error: `Refusing to write through a symlink at ${rel}.`, missing: false };
    }
    return { ok: false, error: errorText(err), missing: false };
  } finally {
    await parent.close();
  }
}

function fdPath(parent: FileHandle, fallbackDir: string, name: string): string {
  if (process.platform === "linux") return `/proc/self/fd/${parent.fd}/${name}`;
  return path.join(fallbackDir, name);
}

async function unlinkQuiet(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    // The temporary file is already gone, or it never appeared.
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function locate(rel: string, cwd: string): Located {
  if (rel.trim() === "") return { ok: false, error: "Path is empty." };
  if (path.isAbsolute(rel)) {
    return { ok: false, error: "Path must be relative to the working directory." };
  }
  const root = path.resolve(cwd);
  const full = path.resolve(root, rel);
  // `a/../b` stays inside cwd. A path that resolves outside it does not.
  if (escapes(root, full)) return { ok: false, error: "Path escapes the working directory." };
  return { ok: true, root, full };
}

async function realRootOf(root: string, rel: string): Promise<{ ok: true; realRoot: string } | PathFailure> {
  try {
    // Remember the real cwd before opening. A later rename of a parent directory
    // must not move the boundary we compare against.
    return { ok: true, realRoot: await realpath(root) };
  } catch (err) {
    if (isEnoent(err)) return { ok: false, error: `No such file: ${rel}`, missing: true };
    return { ok: false, error: errorText(err), missing: false };
  }
}

function parentLabel(root: string, full: string): string {
  const shown = path.relative(root, path.dirname(full));
  return shown === "" ? "." : shown;
}

/** Canonical path of an open file. On Linux this follows the descriptor, not the name. */
async function locationOf(fh: FileHandle, fallback: string): Promise<string> {
  if (process.platform === "linux") return realpath(`/proc/self/fd/${fh.fd}`);
  return realpath(fallback);
}

function escapes(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isEnoent(err: unknown): boolean {
  return codeIs(err, "ENOENT");
}

function isEisdir(err: unknown): boolean {
  return codeIs(err, "EISDIR");
}

function isEnotdir(err: unknown): boolean {
  return codeIs(err, "ENOTDIR");
}

function codeIs(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
