// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// File System Access — the parts TypeScript's DOM lib still does not ship.
//
// The kernel reaches these through `(window as any)`, which is fine where the
// API is one escape hatch in a save path. Home is built ON this API — handles
// are the only thing it stores — so the types are declared once, here, rather
// than casting at every call and losing the compiler exactly where the
// behaviour is subtlest.

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemHandle {
  /** Never prompts — safe to call for a whole list on load. */
  queryPermission(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  /** MUST be called inside a user gesture; browsers refuse otherwise. */
  requestPermission(desc?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string | string[]>
}

interface OpenFilePickerOptions {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: FilePickerAcceptType[]
  id?: string
  startIn?: FileSystemHandle | string
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
}

interface DataTransferItem {
  /**
   * What makes a DROP different from a file input: it yields a real handle, and
   * a dropped handle can be granted write access. `files[0]` gives bytes and no
   * route back to the disk.
   */
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>
}
