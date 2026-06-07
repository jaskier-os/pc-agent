import { readFile, writeFile } from 'fs/promises';

export const name = 'file_edit';
export const description = 'Make precise text replacements in a file. Finds old_string and replaces it with new_string. By default requires old_string to be unique in the file. Use replace_all to replace all occurrences.';
export const parameters = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'Absolute path to the file to edit' },
    old_string: { type: 'string', description: 'The exact text to find and replace' },
    new_string: { type: 'string', description: 'The text to replace it with' },
    replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' }
  },
  required: ['file_path', 'old_string', 'new_string']
};

function normalizeQuotes(s) {
  return s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function findSimilarLines(content, old_string) {
  const prefix = old_string.slice(0, 20);
  const lines = content.split('\n');
  const scored = [];
  for (let i = 0; i < lines.length; i++) {
    let overlap = 0;
    for (let len = prefix.length; len >= 3; len--) {
      if (lines[i].includes(prefix.slice(0, len))) {
        overlap = len;
        break;
      }
    }
    if (overlap > 0) {
      scored.push({ line: i + 1, content: lines[i], overlap });
    }
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, 3);
}

function generateDiff(oldContent, newContent) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let firstChange = -1;
  let lastChangeOld = -1;
  let lastChangeNew = -1;

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (firstChange === -1) firstChange = i;
      if (i < oldLines.length) lastChangeOld = i;
      if (i < newLines.length) lastChangeNew = i;
    }
  }

  if (firstChange === -1) return '';

  const contextLines = 2;
  const startLine = Math.max(0, firstChange - contextLines);
  const endOld = Math.min(oldLines.length - 1, lastChangeOld + contextLines);
  const endNew = Math.min(newLines.length - 1, lastChangeNew + contextLines);

  const parts = [];
  for (let i = startLine; i < firstChange; i++) {
    parts.push(`  ${oldLines[i]}`);
  }
  for (let i = firstChange; i <= lastChangeOld; i++) {
    if (i < oldLines.length && oldLines[i] !== newLines[i]) {
      parts.push(`- ${oldLines[i]}`);
    }
  }
  for (let i = firstChange; i <= lastChangeNew; i++) {
    if (i < newLines.length && oldLines[i] !== newLines[i]) {
      parts.push(`+ ${newLines[i]}`);
    }
  }
  const afterEnd = Math.max(lastChangeOld, lastChangeNew);
  for (let i = afterEnd + 1; i <= Math.min(endOld, endNew); i++) {
    if (i < newLines.length) {
      parts.push(`  ${newLines[i]}`);
    }
  }

  return parts.join('\n');
}

export async function run(params) {
  const { file_path, old_string, new_string } = params;
  const replace_all = params.replace_all || false;

  if (old_string === new_string) {
    return { success: false, error: 'new_string is identical to old_string, no changes needed', file_path };
  }

  try {
    const content = await readFile(file_path, 'utf-8');

    let count = countOccurrences(content, old_string);
    let useNormalized = false;

    if (count === 0) {
      const normContent = normalizeQuotes(content);
      const normOld = normalizeQuotes(old_string);
      const normCount = countOccurrences(normContent, normOld);

      if (normCount > 0) {
        count = normCount;
        useNormalized = true;
      } else {
        const similar = findSimilarLines(content, old_string);
        let hint = '';
        if (similar.length > 0) {
          hint = similar.map(s => `  L${s.line}: ${s.content}`).join('\n');
        }
        const errorMsg = hint
          ? `old_string not found in file. Similar lines:\n${hint}`
          : 'old_string not found in file';
        return { success: false, error: errorMsg, file_path };
      }
    }

    if (count > 1 && !replace_all) {
      return {
        success: false,
        error: `old_string found ${count} times. Use replace_all: true to replace all, or provide a more specific string.`,
        file_path
      };
    }

    let new_content;
    if (useNormalized) {
      const normContent = normalizeQuotes(content);
      const normOld = normalizeQuotes(old_string);

      if (replace_all) {
        new_content = '';
        let pos = 0;
        let normPos = 0;
        while (true) {
          const idx = normContent.indexOf(normOld, normPos);
          if (idx === -1) {
            new_content += content.slice(pos);
            break;
          }
          new_content += content.slice(pos, pos + (idx - normPos)) + new_string;
          pos += (idx - normPos) + normOld.length;
          normPos = idx + normOld.length;
        }
      } else {
        const idx = normContent.indexOf(normOld);
        new_content = content.slice(0, idx) + new_string + content.slice(idx + normOld.length);
      }
    } else if (replace_all) {
      new_content = content.split(old_string).join(new_string);
    } else {
      const idx = content.indexOf(old_string);
      new_content = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
    }

    await writeFile(file_path, new_content, 'utf-8');

    const diff = generateDiff(content, new_content);

    return {
      success: true,
      file_path,
      replacements_made: replace_all ? count : 1,
      diff
    };
  } catch (error) {
    return { success: false, error: error.message, file_path };
  }
}
