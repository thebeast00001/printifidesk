"use client";

import { useCallback } from "react";
import { analyse, kindOf, validate } from "@/lib/analysis";
import { ensureSession, getSupabase } from "@/lib/supabase/client";
import { convertDocument, recordDocument, setDocumentAnalysis, storagePathFor, uploadToStorage } from "@/lib/upload";
import { useApp, type UploadFile } from "@/lib/store";

type Patch = (id: string, patch: Partial<UploadFile>) => void;

/**
 * Drives one file from "dropped" to "priced".
 *
 * Analysis runs before upload on purpose: the page count and colour pages are
 * what the quote needs, and measuring them locally means the price appears
 * immediately instead of after a round trip. The upload then happens behind
 * that, and a failed upload degrades to local-only rather than losing the file.
 */
export function useUploader() {
  const addFile = useApp((s) => s.addFile);
  const updateFile = useApp((s) => s.updateFile);
  const files = useApp((s) => s.files);

  const accept = useCallback(
    async (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      // Read at call time rather than subscribing: a new file starts from
      // whatever the sheet is set to now, and `accept` shouldn't be rebuilt
      // every time a chip moves.
      const sheetConfig = useApp.getState().config;

      for (const file of list) {
        const id = crypto.randomUUID();
        const kind = kindOf(file);

        const problem = validate(file);
        if (problem) {
          addFile({
            id,
            name: file.name,
            kind,
            sizeBytes: file.size,
            selectedPages: [],
            status: "error",
            progress: 0,
            pages: 0,
            colourIndex: [],
            pagesExact: false,
            config: sheetConfig,
            error: problem,
          });
          continue;
        }

        // Same file twice in one job is almost always a mistake.
        if (files.some((f) => f.name === file.name && f.sizeBytes === file.size)) continue;

        addFile({
          id,
          name: file.name,
          kind,
          sizeBytes: file.size,
          // Held so page thumbnails can be rendered without re-downloading.
          file,
          selectedPages: [],
          status: "reading",
          progress: 0,
          pages: 0,
          colourIndex: [],
          pagesExact: false,
          config: sheetConfig,
        });

        void processFile({ id, file, kind, updateFile });
      }
    },
    [addFile, updateFile, files],
  );

  return { accept };
}

async function processFile({
  id,
  file,
  kind,
  updateFile,
}: {
  id: string;
  file: File;
  kind: ReturnType<typeof kindOf>;
  updateFile: Patch;
}) {
  try {
    updateFile(id, { status: "scanning", progress: 0 });

    const analysis = await analyse(file, (done, total) => {
      updateFile(id, { progress: total ? done / total : 0 });
    });

    updateFile(id, {
      pages: analysis.pages,
      colourIndex: analysis.colourIndex,
      pagesExact: analysis.exact,
      note: analysis.note,
      progress: 1,
    });

    const session = await ensureSession();

    if (session.status !== "ready") {
      // The file is already measured and priced, so it stays in the job. It
      // just can't be saved to an account yet.
      updateFile(id, {
        status: "ready",
        localOnly: true,
        progress: 1,
        note:
          session.status === "signed-out"
            ? "Kept on this device — sign in to save it to your account."
            : session.status === "loading"
              ? "Kept on this device — still signing you in."
              : session.message,
      });
      return;
    }

    updateFile(id, { status: "uploading", progress: 0 });
    const path = storagePathFor(session.userId, id, file.name);

    await uploadToStorage({
      file,
      path,
      accessToken: session.accessToken,
      onProgress: (fraction) => updateFile(id, { progress: fraction }),
    });

    await recordDocument({ id, userId: session.userId, file, kind, path, analysis });

    if (kind !== "OFFICE") {
      updateFile(id, { status: "ready", storagePath: path, progress: 1 });
      return;
    }

    // An office file: the server turns it into a PDF (0041), which is then
    // measured here exactly as an uploaded PDF would be — pages, colour,
    // thumbnails — and the counts written to the row. If any of that fails
    // the original stays: the desk opens it as it always did, with the
    // estimate marked as one.
    updateFile(id, { status: "scanning", progress: 0, note: "Converting to PDF…" });
    try {
      const converted = await convertDocument(id);
      const supabase = getSupabase();
      const signed = supabase ? await supabase.storage.from("documents").createSignedUrl(converted.storage_path, 120) : null;
      if (!signed?.data?.signedUrl) throw new Error("Converted, but the PDF couldn't be read back.");
      const blob = await (await fetch(signed.data.signedUrl)).blob();
      const pdf = new File([blob], converted.name, { type: "application/pdf" });
      const measured = await analyse(pdf, (done, total) => updateFile(id, { progress: total ? done / total : 0 }));
      if (measured.exact) await setDocumentAnalysis(id, measured.pages, measured.colourIndex);
      updateFile(id, {
        status: "ready",
        storagePath: converted.storage_path,
        name: converted.name,
        kind: "PDF",
        sizeBytes: converted.size_bytes,
        file: pdf,
        pages: measured.pages,
        colourIndex: measured.colourIndex,
        pagesExact: measured.exact,
        note: measured.exact ? undefined : measured.note,
        progress: 1,
      });
    } catch (error) {
      updateFile(id, {
        status: "ready",
        storagePath: path,
        progress: 1,
        note: `Couldn't convert it to PDF (${error instanceof Error ? error.message : "no reply"}) — the desk opens the original, and confirms the page count.`,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    // The file is measured and usable even if it never reached the server, so
    // keep it in the job rather than dropping the user back to an empty sheet.
    updateFile(id, { status: "ready", localOnly: true, progress: 1, note: message });
  }
}
