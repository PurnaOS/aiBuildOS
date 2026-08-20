/**
 * Previews (RQ-0025, DC-0012): the project's declared run command as a child server, rendered in
 * a WebContentsView main positions from the renderer's reported bounds.
 *
 * Stubs until ST-0039 lands — the channels and handlers exist so the lane building this never
 * edits the shared files.
 */

export async function startPreview(
  _projectPath: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  return { ok: false, message: "Previews are not built yet." };
}

export async function stopPreview(_projectPath: string): Promise<{ problem: string | null }> {
  return { problem: null };
}

export function setPreviewBounds(_bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): void {
  // The view does not exist yet; ST-0039 attaches it to the window and moves it from here.
}
