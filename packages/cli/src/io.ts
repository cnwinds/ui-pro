/** Anything text can be written to; `process.stdout` and test buffers both fit. */
export interface TextSink {
  write(chunk: string): unknown;
}

export interface CliIo {
  /** Directory relative paths and project discovery start from. */
  cwd: string;
  /** Only read by commands that accept `-` for standard input. */
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: TextSink;
  stderr?: TextSink;
}

export async function readAll(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
