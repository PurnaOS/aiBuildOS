/**
 * What the file tree's context menu acts on (RQ-0006#AC-9).
 *
 * Separated from the menu itself so it can be tested: showing a menu needs a running Electron and an
 * operating system willing to draw one, but deciding *what a right-click meant* needs neither.
 */
export function fileMenuTarget(path: string, directory: boolean): string {
  // A file's menu acts on the folder it sits in: "make one beside this" is the same question as
  // "make one in here", asked from a different row. A file at the root leaves `""`, the project.
  if (directory) return path;
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}
