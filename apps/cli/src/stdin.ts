/** Reads all of STDIN as a UTF-8 string. Used by `whyguard guard --stdin`. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf-8"));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
