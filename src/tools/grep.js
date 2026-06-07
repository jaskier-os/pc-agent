import { exec } from 'child_process';

export const name = 'grep';
export const description = 'Search for a regex pattern across files. Supports content matching with line numbers, file listing, and match counting. Default exclusions: node_modules, .git, dist, build.';
export const parameters = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Regex pattern to search for' },
    path: { type: 'string', description: 'Directory or file to search in (default: current directory)' },
    include: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.js", "*.py")' },
    output_mode: {
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
      description: 'Output mode: "content" shows matching lines (default), "files_with_matches" shows only file paths, "count" shows match counts per file'
    },
    context: { type: 'number', description: 'Number of context lines around each match (grep -C)' },
    case_insensitive: { type: 'boolean', description: 'Case insensitive search (grep -i)' },
    type: { type: 'string', description: 'File type shorthand (e.g., "js", "py", "ts"). Takes precedence over include.' },
    head_limit: { type: 'number', description: 'Limit number of returned results' },
    offset: { type: 'number', description: 'Skip first N results before applying head_limit' }
  },
  required: ['pattern']
};

const MAX_RESULTS = 500;

const DEFAULT_EXCLUSIONS = [
  '--exclude-dir=node_modules',
  '--exclude-dir=.git',
  '--exclude-dir=dist',
  '--exclude-dir=build',
  '--binary-files=without-match'
];

const TYPE_MAP = {
  js: '*.js',
  ts: '*.ts',
  py: '*.py',
  java: '*.java',
  go: '*.go',
  rust: '*.rs',
  c: '*.c',
  cpp: '*.cpp',
  rb: '*.rb',
  php: '*.php',
  css: '*.css',
  html: '*.html',
  json: '*.json',
  yaml: '*.{yaml,yml}',
  md: '*.md',
  sh: '*.sh'
};

function escape_single_quotes(str) {
  return str.replace(/'/g, "'\\''");
}

function validate_path(p) {
  if (p && (/[\x00\n\r]/.test(p) || /[;|&`$()]/.test(p))) {
    return false;
  }
  return true;
}

function build_command(params, mode) {
  const parts = ['grep', '-r'];

  if (mode === 'content') {
    parts.push('-n');
  } else if (mode === 'files_with_matches') {
    parts.push('-l');
  } else if (mode === 'count') {
    parts.push('-c');
  }

  parts.push('-E');
  parts.push(...DEFAULT_EXCLUSIONS);

  if (params.case_insensitive) {
    parts.push('-i');
  }

  if (mode === 'content' && params.context != null && params.context > 0) {
    parts.push(`-C ${params.context}`);
  }

  // type takes precedence over include
  if (params.type && TYPE_MAP[params.type]) {
    parts.push(`--include='${TYPE_MAP[params.type]}'`);
  } else if (params.include) {
    parts.push(`--include='${escape_single_quotes(params.include)}'`);
  }

  const search_path = params.path || '.';
  parts.push(`'${escape_single_quotes(params.pattern)}'`);
  parts.push(`'${escape_single_quotes(search_path)}'`);

  return parts.join(' ');
}

function parse_content_output(output) {
  if (!output?.trim()) return [];
  return output.trim().split('\n').map(line => {
    // Match standard grep output: file:linenum:content
    const matchColon = line.match(/^(.+?):(\d+):(.*)$/);
    if (matchColon) return { file: matchColon[1], line: parseInt(matchColon[2], 10), content: matchColon[3] };
    // Match context lines from grep -C: file-linenum-content
    const matchHyphen = line.match(/^(.+?)-(\d+)-(.*)$/);
    if (matchHyphen) return { file: matchHyphen[1], line: parseInt(matchHyphen[2], 10), content: matchHyphen[3] };
    // Separator lines (--) are skipped
    return null;
  }).filter(Boolean);
}

function parse_files_output(output) {
  if (!output?.trim()) return [];
  return output.trim().split('\n').filter(Boolean);
}

function parse_count_output(output) {
  if (!output?.trim()) return [];
  return output.trim().split('\n').map(line => {
    const match = line.match(/^(.+?):(\d+)$/);
    if (!match) return null;
    const count = parseInt(match[2], 10);
    if (count === 0) return null;
    return { file: match[1], count };
  }).filter(Boolean);
}

function apply_pagination(items, offset, head_limit) {
  let result = items;
  if (offset != null && offset > 0) {
    result = result.slice(offset);
  }
  if (head_limit != null && head_limit > 0) {
    result = result.slice(0, head_limit);
  }
  return result;
}

export async function run(params) {
  if (!validate_path(params.path)) {
    return { success: false, error: 'Invalid path: contains shell metacharacters' };
  }
  const mode = params.output_mode || 'content';
  const cmd = build_command(params, mode);

  return new Promise((resolve) => {
    exec(cmd, { shell: '/bin/bash', timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) {
        if (error.code === 1) {
          // grep exit code 1 = no matches
          if (mode === 'files_with_matches') {
            resolve({ success: true, files: [], count: 0, truncated: false });
          } else if (mode === 'count') {
            resolve({ success: true, counts: [], total: 0, truncated: false });
          } else {
            resolve({ success: true, results: [], total_matches: 0, truncated: false });
          }
          return;
        }
        resolve({ success: false, error: error.message });
        return;
      }

      if (mode === 'files_with_matches') {
        const all_files = parse_files_output(stdout);
        const total = all_files.length;
        const capped = total > MAX_RESULTS ? all_files.slice(0, MAX_RESULTS) : all_files;
        const paginated = apply_pagination(capped, params.offset, params.head_limit);
        resolve({
          success: true,
          files: paginated,
          count: total,
          truncated: total > MAX_RESULTS
        });
      } else if (mode === 'count') {
        const all_counts = parse_count_output(stdout);
        const total = all_counts.reduce((sum, entry) => sum + entry.count, 0);
        const capped = all_counts.length > MAX_RESULTS ? all_counts.slice(0, MAX_RESULTS) : all_counts;
        const paginated = apply_pagination(capped, params.offset, params.head_limit);
        resolve({
          success: true,
          counts: paginated,
          total,
          truncated: all_counts.length > MAX_RESULTS
        });
      } else {
        const all_results = parse_content_output(stdout);
        const total_matches = all_results.length;
        const capped = total_matches > MAX_RESULTS ? all_results.slice(0, MAX_RESULTS) : all_results;
        const paginated = apply_pagination(capped, params.offset, params.head_limit);
        resolve({
          success: true,
          results: paginated,
          total_matches,
          truncated: total_matches > MAX_RESULTS
        });
      }
    });
  });
}
