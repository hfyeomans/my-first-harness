import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_BYTES = 200_000;

export type PathFailure = { ok: false; error: string; missing: boolean };

type Located = { ok: true; root: string; full: string } | { ok: false; error: string };

/** Open an existing file that stays inside `cwd`, or a path error. Caller closes the handle. */
export async function openInside(
  rel: string,
  cwd: string,
  flags: string | number,
): Promise<{ ok: true; handle: FileHandle } | PathFailure> {
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
  return { ok: true, handle };
}

/**
 * Create a new file inside `cwd`. The parent must already exist.
 * Nothing is written when the parent resolves outside cwd.
 */
export async function createInside(rel: string, cwd: string, content: string): Promise<{ ok: true } | PathFailure> {
  const located = locate(rel, cwd);
  if (!located.ok) return { ok: false, error: located.error, missing: false };

  const root = await realRootOf(located.root, rel);
  if (!root.ok) return root;

  const parentFull = path.dirname(located.full);
  let parent: FileHandle;
  try {
    parent = await open(parentFull, "r");
  } catch (err) {
    const shown = parentLabel(located.root, located.full);
    if (isEnoent(err)) return { ok: false, error: `No such directory: ${shown}`, missing: true };
    if (isEnotdir(err)) return { ok: false, error: `${shown} is not a directory.`, missing: false };
    return { ok: false, error: errorText(err), missing: false };
  }

  try {
    const parentReal = await locationOf(parent, parentFull);
    if (escapes(root.realRoot, parentReal)) {
      return { ok: false, error: "Path escapes the working directory.", missing: false };
    }

    // Create through the directory fd we just checked. Opening the path by name
    // afterwards is a second lookup. O_NOFOLLOW refuses a symlink as the last
    // component. Linux can name that fd; elsewhere we fall back to the path,
    // the same split read_file uses for the opened descriptor.
    const name = path.basename(located.full);
    const target = process.platform === "linux" ? `/proc/self/fd/${parent.fd}/${name}` : located.full;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    let created: FileHandle;
    try {
      created = await open(target, flags, 0o666);
    } catch (err) {
      if (codeIs(err, "EEXIST")) {
        return { ok: false, error: `Cannot create ${rel}: the path already exists.`, missing: false };
      }
      if (codeIs(err, "ELOOP")) {
        return { ok: false, error: `Refusing to write through a symlink at ${rel}.`, missing: false };
      }
      return { ok: false, error: errorText(err), missing: false };
    }

    try {
      await created.writeFile(content);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err), missing: false };
    } finally {
      await created.close();
    }
  } catch (err) {
    return { ok: false, error: errorText(err), missing: false };
  } finally {
    await parent.close();
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
