// What a module id looks like. Its own file, with no imports, so the pure
// descriptions of a module (its manifest, the catalog) can check an id without
// pulling the filesystem in with the paths.

export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export function assertModuleId(moduleId: string): void {
  if (!MODULE_ID_PATTERN.test(moduleId)) {
    throw new Error(`Invalid module id: ${moduleId}`);
  }
}
