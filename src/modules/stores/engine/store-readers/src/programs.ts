// The one kind of file a guest's upload refuses: a program, alone or inside a zip. A store keeps any kind of file, whether
// or not LOAD reads it into tables (accepted.ts lists the kinds it reads): a database backup, a PDF,
// a picture, a zip. A program is not data. An operating system runs or installs it when a person
// opens it, so whoever downloads it from the store later could run it with a double-click. The
// upload page refuses one before a byte goes up (the api hands it this list), and the store refuses
// one a guest names (store-object's files.ts), so the rule holds for a request the page never
// made. It imports nothing, so reading the list loads no reader.
//
// A zip is fine; a program inside one is not (Denis, 2026-11-20). A zip lists its files at its end,
// so the page reads that list before the zip uploads, and the store reads it once the bytes arrive
// (`programsInZip`). Only the zip's own list is read: a zip inside it is not opened.
//
// The list is short on purpose: only what runs, installs or changes the system when a person opens
// it on a common setup. It leaves out what a town's old system is made of, which may arrive as data:
// an Access project (.mde, .accde, .adp), a FoxPro form's memo (.sct), program source (.prg) or
// compiled application (.app, .fxp), a library (.dll), a SQL script (.sql), a GIS raster (.img),
// and an archive (.zip, .cab, .7z), which holds files and runs nothing.

/** The extensions of a program, lowercase, without the dot. */
export const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows: programs, screen savers, Control Panel items and console snap-ins.
  "exe",
  "com",
  "scr",
  "pif",
  "cpl",
  "msc",
  // Windows: installers.
  "msi",
  "msp",
  "msix",
  "msixbundle",
  "appx",
  "appxbundle",
  // Windows: scripts, shortcuts and registry files, which run or change the system when opened.
  "bat",
  "cmd",
  "ps1",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "hta",
  "lnk",
  "reg",
  // Java: runs when opened where Java is installed, or starts a program from the web.
  "jar",
  "jnlp",
  // Python: runs when opened where Python is installed.
  "py",
  "pyw",
  // macOS: the disk image and the installers programs come in, and a script Terminal runs when opened.
  "dmg",
  "pkg",
  "mpkg",
  "command",
  // Linux: shell scripts, portable programs and packages.
  "sh",
  "appimage",
  "deb",
  "rpm",
  // Phones: Android and iOS apps.
  "apk",
  "ipa",
]);

/**
 * A file name's last extension, lowercase, as a disk saves the name: dots and spaces at its end are
 * not part of it, because Windows drops them when it saves a file ("setup.exe." arrives on a disk as
 * "setup.exe"). "" when the name has none.
 */
function lastExtension(fileName: string): string {
  const last = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/[\s.]+$/, "");
  const dot = last.lastIndexOf(".");
  return dot >= 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/**
 * Whether a file's name says it is a program. Only the last extension counts, as it does for the
 * operating system: "setup.exe.zip" is a zip, whose own list says whether a program is in it.
 */
export function isProgramFile(fileName: string): boolean {
  return PROGRAM_EXTENSIONS.has(lastExtension(fileName));
}

/** Whether a file's name says it is a zip, whose list of files is read before a guest's upload takes it. */
export function isZipFile(fileName: string): boolean {
  return lastExtension(fileName) === "zip";
}

/**
 * The programs a zip holds, by the names in its list of files, each as its path in the zip, once,
 * in the zip's order: a file whose name is a program's (`isProgramFile`), and a macOS app, a folder
 * named "<name>.app" that holds its "Contents" folder. Folders, and the files a Mac adds to a zip on
 * its own (`__MACOSX/`, names that start with "._"), are not programs.
 */
export function programsInZip(names: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const listed of names) {
    const name = listed.replace(/\\/g, "/").replace(/^\/+/, "");
    if (name.startsWith("__MACOSX/")) continue;
    const parts = name.split("/");
    const app = parts.findIndex((part, i) => /\.app$/i.test(part) && parts[i + 1] === "Contents");
    if (app >= 0) found.add(parts.slice(0, app + 1).join("/"));
    else if (!name.endsWith("/") && !(parts[parts.length - 1] ?? "").startsWith("._") && isProgramFile(name)) found.add(name);
  }
  return [...found];
}
