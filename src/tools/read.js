import { readFile, stat, readdir } from 'fs/promises';
import { dirname, basename, extname } from 'path';
import { createHash } from 'crypto';

export const name = 'file_read';
export const description = 'Read a file from the filesystem. Returns content with line numbers. Supports offset and limit for reading specific sections of large files.';
export const parameters = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Absolute path to the file to read' },
    offset: { type: 'number', description: 'Line number to start reading from (1-based, default: 1)' },
    limit: { type: 'number', description: 'Maximum number of lines to read (default: 2000)' }
  },
  required: ['file_path']
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff']);

function findSimilarFiles(files, target) {
  const lower = target.toLowerCase();
  const base = lower.replace(/\.[^.]+$/, '');
  return files.filter(f => {
    const fl = f.toLowerCase();
    return fl.includes(base.slice(0, 4)) || base.includes(fl.replace(/\.[^.]+$/, '').slice(0, 4));
  }).slice(0, 5);
}

export async function run(params, context = {}) {
  const { file_path } = params;
  const offset = Math.max(1, params.offset || 1);
  const limit = params.limit || 2000;

  try {
    const file_stat = await stat(file_path);
    if (file_stat.isDirectory()) {
      return { success: false, error: `Path is a directory, not a file: ${file_path}` };
    }

    const buffer = await readFile(file_path);

    const null_check = buffer.slice(0, 512);
    if (null_check.includes(0)) {
      const ext = extname(file_path).toLowerCase();
      const label = IMAGE_EXTENSIONS.has(ext) ? 'Image file detected' : 'Binary file detected';
      return {
        success: false,
        error: `${label}: ${file_path} (${file_stat.size} bytes)`
      };
    }

    const content = buffer.toString('utf-8');
    const all_lines = content.split('\n');
    const total_lines = all_lines.length;

    const start = offset - 1;
    const selected = all_lines.slice(start, start + limit);

    const max_num_width = String(start + selected.length).length;
    const formatted = selected.map((line, i) => {
      const line_num = String(start + i + 1).padStart(max_num_width);
      return `${line_num}\t${line}`;
    }).join('\n');

    if (context.readFiles instanceof Map) {
      const hash = createHash('md5').update(buffer).digest('hex');
      context.readFiles.set(file_path, hash);
    }

    return {
      success: true,
      content: formatted,
      total_lines,
      size: file_stat.size,
      modified: file_stat.mtime.toISOString(),
      file_path,
      truncated: total_lines > start + limit
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      const dir = dirname(file_path);
      const target = basename(file_path);
      try {
        const files = await readdir(dir);
        const similar = findSimilarFiles(files, target);
        const suggestion = similar.length > 0
          ? ` Did you mean: ${similar.join(', ')}?`
          : '';
        return { success: false, error: `File not found: ${file_path}.${suggestion}`, file_path };
      } catch {
        return { success: false, error: `File not found: ${file_path}`, file_path };
      }
    }
    return { success: false, error: error.message, file_path };
  }
}
