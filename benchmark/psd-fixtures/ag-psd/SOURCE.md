# Photoshop-authored PSD fixtures

Copied from the [ag-psd](https://github.com/Agamnentzar/ag-psd) test suite (`test/read/<name>/`), commit `b67cc03da0479c0cc0d376f69c6a0b0b7af999d8`, under the MIT license in `LICENSE`.

Each folder holds:

- `src.psd`: a file saved by Photoshop.
- `canvas.png`: the composite image embedded in that file, i.e. Photoshop's own rendering. It is the ground truth for per-layer render checks.

These files are not game UI. They exercise layer styles, blend modes, masks, groups, text, and smart objects, which is what the program-side layer renderer must reproduce.
