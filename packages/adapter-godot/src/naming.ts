/** `btn_upgrade` -> `BtnUpgrade`; `-` separates words like `_` does. */
export function toPascalCase(text: string): string {
  return text
    .split(/[_-]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** Godot file and directory names are lowercase with underscores: `character-page` -> `character_page`. */
export function toFileStem(text: string): string {
  return text.replaceAll('-', '_');
}

/**
 * Node names for `ids`. Two ids can collapse to one name (`a_1` and `a1`); unique names must be
 * unique across the scene, so ids are served in sorted order and later ones get a `_2`, `_3` suffix.
 */
export function assignNodeNames(
  ids: readonly string[],
  reserved: readonly string[] = [],
): Map<string, string> {
  const used = new Set(reserved);
  const names = new Map<string, string>();
  for (const id of [...ids].sort()) {
    const base = toPascalCase(id);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    names.set(id, name);
  }
  return names;
}
