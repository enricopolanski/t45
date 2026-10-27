import type { DragEvent } from "react";

import { toastManager } from "../ui/toast";

interface FileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
}

const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");

const movedWithinDropTarget = (event: DragEvent) =>
  event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);

/** For a view that takes no files: file drags show no-drop, and the browser doesn't open the file. */
export const refuseFileDrop = {
  onDragOver(event: DragEvent) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  },
};

/** Drag handlers for a drop target that takes files; a dropped folder is refused with a toast. */
export function makeFileDropHandlers(host: FileDropHost) {
  return {
    onDragEnter(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      host.setDragActive(false);
      const files: File[] = [];
      let droppedFolder = false;
      for (const item of event.dataTransfer.items) {
        const file = item.kind === "file" ? item.getAsFile() : null;
        if (file === null) continue;
        if (item.webkitGetAsEntry()?.isDirectory) droppedFolder = true;
        else files.push(file);
      }
      if (files.length > 0) host.addFiles(files);
      if (droppedFolder) {
        toastManager.add({
          type: "error",
          title: "Folders can't be dropped into the composer",
          description: "Attach the files inside it instead.",
        });
      }
    },
  };
}
