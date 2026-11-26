import type { ModelName } from '../pixel/types';

export interface ModelSpec {
  name: ModelName;
  /** What it is for, in Simplified Chinese. */
  purpose: string;
  /** File name in the model cache directory. */
  file: string;
  /** HuggingFace repository and path; the download URL is `<endpoint>/<repo>/resolve/main/<path>`. */
  repo: string;
  path: string;
  sha256: string;
  bytes: number;
  /** SPDX identifier; every model here allows commercial use. */
  license: string;
  /** Input and output tensors, as published with the model. */
  io: string;
}

/** Checked on 2026-11-26 against the HuggingFace API (sizes and LFS hashes). */
export const MODEL_CATALOG: Readonly<Record<ModelName, ModelSpec>> = {
  lama: {
    name: 'lama',
    purpose: '遮挡补全与文字剥离的本地初稿',
    file: 'lama_fp32.onnx',
    repo: 'Carve/LaMa-ONNX',
    path: 'lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    bytes: 208_044_816,
    license: 'Apache-2.0',
    io: 'image 1x3x512x512 float32 in [0,1] RGB; mask 1x1x512x512 float32, 1 = hole; output 1x3x512x512',
  },
  'realesr-animevideov3': {
    name: 'realesr-animevideov3',
    purpose: '提升分辨率的本地初稿（卡通、动漫风格）',
    file: 'animevideov3_nchw_256x256_fp32.onnx',
    repo: 'Tomoali/realesr-animevideov3-onnx',
    path: 'animevideov3_nchw_256x256_fp32.onnx',
    sha256: '139f166bd2b955c7d4cd31ca2616eb97dacc4365c1c315d880735ce72a0663d9',
    bytes: 2_494_775,
    license: 'BSD-3-Clause',
    io: 'fixed 1x3x256x256 float32 in [0,1] RGB, NCHW -> 1x3x1024x1024 (4x); tile larger images',
  },
  'anime-seg': {
    name: 'anime-seg',
    purpose: '角色立绘的抠取（ISNet，动漫角色分割）',
    file: 'isnetis.onnx',
    repo: 'skytnt/anime-seg',
    path: 'isnetis.onnx',
    sha256: 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99',
    bytes: 176_069_933,
    license: 'Apache-2.0',
    io: 'see the skytnt/anime-seg README: RGB float32 in [0,1], square input (1024), one-channel mask out',
  },
};

/** Tried in order; `HF_ENDPOINT` from the environment goes first when set. */
export const MODEL_ENDPOINTS = ['https://huggingface.co', 'https://hf-mirror.com'] as const;
