import * as ort from 'onnxruntime-node';

export type { InferenceSession, Tensor } from 'onnxruntime-node';
export { Tensor as OrtTensor } from 'onnxruntime-node';

const sessions = new Map<string, Promise<ort.InferenceSession>>();

export interface SessionOptions {
  env?: NodeJS.ProcessEnv;
  /** Told when a requested execution provider could not be used. */
  onWarning?: (message: string) => void;
}

/**
 * The ONNX session of a model file; built once per process and shared. CPU by default;
 * `UI_PRO_ORT_EP=dml` tries DirectML first and falls back to CPU when it cannot be created.
 */
export function loadSession(
  file: string,
  options: SessionOptions = {},
): Promise<ort.InferenceSession> {
  const env = options.env ?? process.env;
  const wantsDml = env.UI_PRO_ORT_EP?.toLowerCase() === 'dml';
  const key = `${file}|${wantsDml ? 'dml' : 'cpu'}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const created = (async () => {
    if (wantsDml) {
      try {
        return await ort.InferenceSession.create(file, { executionProviders: ['dml', 'cpu'] });
      } catch (error) {
        options.onWarning?.(
          `DirectML 不可用，改用 CPU 推理（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    }
    return ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
  })();
  sessions.set(key, created);
  created.catch(() => sessions.delete(key));
  return created;
}
