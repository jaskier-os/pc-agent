import { glob } from 'glob';
import { stat } from 'fs/promises';

export const name = 'file_glob';
export const description = 'Find files matching a glob pattern. Returns matching file paths sorted by modification time (most recent first). Supports patterns like "**/*.js", "src/**/*.ts", etc.';
export const parameters = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "**/*.js", "src/**/*.ts")' },
    path: { type: 'string', description: 'Base directory to search from (default: current directory)' }
  },
  required: ['pattern']
};

const MAX_RESULTS = 200;

export async function run(params) {
  const { pattern } = params;
  const search_path = params.path || '.';
  const start = Date.now();

  try {
    const files = await glob(pattern, {
      cwd: search_path,
      absolute: true,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**']
    });

    const total = files.length;
    const truncated = total > MAX_RESULTS;
    const capped = truncated ? files.slice(0, MAX_RESULTS) : files;

    // Stat each file in parallel for mtime, handle errors gracefully
    const stat_results = await Promise.all(
      capped.map(async (file_path) => {
        try {
          const info = await stat(file_path);
          return { file: file_path, mtime: info.mtimeMs };
        } catch {
          // File may have been deleted between glob and stat -- push to end
          return { file: file_path, mtime: 0 };
        }
      })
    );

    // Sort by mtime descending (most recently modified first)
    stat_results.sort((a, b) => b.mtime - a.mtime);

    const result_files = stat_results.map(entry => entry.file);
    const duration_ms = Date.now() - start;

    return {
      success: true,
      files: result_files,
      count: total,
      truncated,
      duration_ms
    };
  } catch (error) {
    const duration_ms = Date.now() - start;
    return { success: false, error: error.message, duration_ms };
  }
}
