import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { dirname } from 'path';
import { createHash } from 'crypto';

export const name = 'file_write';
export const description = 'Write content to a file. Creates parent directories automatically. Overwrites the file if it already exists.';
export const parameters = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Absolute path to the file to write' },
    content: { type: 'string', description: 'The content to write to the file' }
  },
  required: ['file_path', 'content']
};

export async function run(params, context = {}) {
  const { file_path, content } = params;

  try {
    let fileExists = false;
    try {
      await stat(file_path);
      fileExists = true;
    } catch {
      // File does not exist, will be created
    }

    if (fileExists && context.readFiles instanceof Map) {
      if (!context.readFiles.has(file_path)) {
        return { success: false, error: 'You must read the file before overwriting it. Use file_read first.', file_path };
      }

      const currentBuffer = await readFile(file_path);
      const currentHash = createHash('md5').update(currentBuffer).digest('hex');
      const storedHash = context.readFiles.get(file_path);

      if (currentHash !== storedHash) {
        return { success: false, error: 'File was modified externally since last read. Read it again before overwriting.', file_path };
      }
    }

    const dir = dirname(file_path);
    await mkdir(dir, { recursive: true });
    await writeFile(file_path, content, 'utf-8');

    if (context.readFiles instanceof Map) {
      const newHash = createHash('md5').update(Buffer.from(content, 'utf-8')).digest('hex');
      context.readFiles.set(file_path, newHash);
    }

    return {
      success: true,
      file_path,
      bytes_written: Buffer.byteLength(content, 'utf-8')
    };
  } catch (error) {
    return { success: false, error: error.message, file_path };
  }
}
