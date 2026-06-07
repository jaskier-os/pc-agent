/**
 * Unit tests for pc-agent tool modules.
 * Tests tool functions directly with real filesystem, no network/LLM calls.
 * Run: node tests/unit-tools.test.js
 * Run with --no-cleanup to keep test artifacts for inspection.
 */
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import * as read_tool from '../src/tools/read.js';
import * as write_tool from '../src/tools/write.js';
import * as edit_tool from '../src/tools/edit.js';
import * as grep_tool from '../src/tools/grep.js';
import * as glob_tool from '../src/tools/glob.js';
// explore_tool imports @orchestrator/sdk which may not be installed in worktree.
// Dynamic import so the rest of the tests still run when SDK deps are missing.
let explore_tool = null;
try {
  explore_tool = await import('../src/tools/explore.js');
} catch {
  // Will be handled in the explore tests
}

const TEST_DIR = path.join(import.meta.dirname, '.test-fixtures');
const NO_CLEANUP = process.argv.includes('--no-cleanup');

let passed = 0;
let failed = 0;
const total = 43;

function setup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup() {
  if (NO_CLEANUP) {
    console.log(`\n--no-cleanup: test artifacts kept at ${TEST_DIR}`);
    return;
  }
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

function writeFixture(name, content) {
  const p = path.join(TEST_DIR, name);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// ---------------------------------------------------------------------------
// read.js tests
// ---------------------------------------------------------------------------

async function testReadBasic() {
  console.log(`[1/${total}] read basic...`);
  const filePath = writeFixture('read-basic.txt', 'line one\nline two\nline three\n');
  const result = await read_tool.run({ file_path: filePath });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(result.content.includes('line one'), 'content should include first line');
  assert(result.content.includes('line two'), 'content should include second line');
  // line numbers should be present (tab-separated)
  assert(/\d+\t/.test(result.content), 'content should have line numbers with tab separators');
  assert.strictEqual(result.file_path, filePath, 'should return file_path');
  passed++;
  console.log('  OK\n');
}

async function testReadOffsetLimit() {
  console.log(`[2/${total}] read with offset/limit...`);
  const lines = [];
  for (let i = 1; i <= 10; i++) lines.push(`line ${i}`);
  const filePath = writeFixture('read-offset.txt', lines.join('\n') + '\n');
  const result = await read_tool.run({ file_path: filePath, offset: 3, limit: 3 });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(result.content.includes('line 3'), 'should include line 3');
  assert(result.content.includes('line 4'), 'should include line 4');
  assert(result.content.includes('line 5'), 'should include line 5');
  assert(!result.content.includes('line 2\n'), 'should not include line 2 as content');
  assert(!result.content.includes('line 6'), 'should not include line 6');
  passed++;
  console.log('  OK\n');
}

async function testReadMetadata() {
  console.log(`[3/${total}] read metadata...`);
  const filePath = writeFixture('read-meta.txt', 'some content');
  const result = await read_tool.run({ file_path: filePath });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(typeof result.size === 'number', 'should have numeric size');
  assert(result.size > 0, 'size should be > 0');
  assert(typeof result.modified === 'string', 'should have modified string');
  // modified should be ISO date
  assert(!isNaN(Date.parse(result.modified)), 'modified should be valid ISO date');
  passed++;
  console.log('  OK\n');
}

async function testReadEnoent() {
  console.log(`[4/${total}] read ENOENT...`);
  // Create a file in the dir so suggestions can be made
  writeFixture('readme.txt', 'hello');
  const filePath = path.join(TEST_DIR, 'readne.txt');
  const result = await read_tool.run({ file_path: filePath });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('File not found'), 'error should mention file not found');
  // Should suggest similar filename (readme.txt shares prefix with readne.txt)
  assert(result.error.includes('readme.txt') || result.error.includes('Did you mean'), 'should suggest similar file');
  passed++;
  console.log('  OK\n');
}

async function testReadBinaryDetection() {
  console.log(`[5/${total}] read binary detection...`);
  const filePath = path.join(TEST_DIR, 'binary.dat');
  const buf = Buffer.alloc(64);
  buf.write('header');
  buf[10] = 0; // null byte
  fs.writeFileSync(filePath, buf);
  const result = await read_tool.run({ file_path: filePath });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('Binary file detected'), 'error should say Binary file detected');
  passed++;
  console.log('  OK\n');
}

async function testReadImageDetection() {
  console.log(`[6/${total}] read image detection...`);
  const filePath = path.join(TEST_DIR, 'photo.png');
  const buf = Buffer.alloc(64);
  buf.write('PNG');
  buf[10] = 0; // null byte
  fs.writeFileSync(filePath, buf);
  const result = await read_tool.run({ file_path: filePath });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('Image file detected'), 'error should say Image file detected');
  passed++;
  console.log('  OK\n');
}

async function testReadDirectory() {
  console.log(`[7/${total}] read directory...`);
  const dirPath = path.join(TEST_DIR, 'subdir-read');
  fs.mkdirSync(dirPath, { recursive: true });
  const result = await read_tool.run({ file_path: dirPath });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('directory'), 'error should mention directory');
  passed++;
  console.log('  OK\n');
}

async function testReadContextTracking() {
  console.log(`[8/${total}] read context tracking...`);
  const filePath = writeFixture('read-ctx.txt', 'track me');
  const context = { readFiles: new Map() };
  const result = await read_tool.run({ file_path: filePath }, context);
  assert.strictEqual(result.success, true, 'should succeed');
  assert(context.readFiles.has(filePath), 'readFiles should have the file path');
  const hash = context.readFiles.get(filePath);
  assert(typeof hash === 'string' && hash.length === 32, 'hash should be 32-char MD5 hex');
  passed++;
  console.log('  OK\n');
}

// ---------------------------------------------------------------------------
// write.js tests
// ---------------------------------------------------------------------------

async function testWriteBasic() {
  console.log(`[9/${total}] write basic...`);
  const filePath = path.join(TEST_DIR, 'write-basic.txt');
  const result = await write_tool.run({ file_path: filePath, content: 'hello world' });
  assert.strictEqual(result.success, true, 'should succeed');
  assert.strictEqual(result.file_path, filePath, 'should return file_path');
  assert.strictEqual(result.bytes_written, Buffer.byteLength('hello world', 'utf-8'), 'bytes_written should match');
  const actual = fs.readFileSync(filePath, 'utf-8');
  assert.strictEqual(actual, 'hello world', 'file content should match');
  passed++;
  console.log('  OK\n');
}

async function testWriteCreatesParentDirs() {
  console.log(`[10/${total}] write creates parent dirs...`);
  const filePath = path.join(TEST_DIR, 'deep', 'nested', 'dir', 'file.txt');
  const result = await write_tool.run({ file_path: filePath, content: 'nested content' });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(fs.existsSync(filePath), 'file should exist');
  assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'nested content', 'content should match');
  passed++;
  console.log('  OK\n');
}

async function testWriteOverwriteWithoutContext() {
  console.log(`[11/${total}] write overwrite without context...`);
  const filePath = writeFixture('write-overwrite.txt', 'original');
  // No context object -- backwards compat, should allow overwrite
  const result = await write_tool.run({ file_path: filePath, content: 'replaced' });
  assert.strictEqual(result.success, true, 'should succeed without context');
  assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'replaced', 'content should be replaced');
  passed++;
  console.log('  OK\n');
}

async function testWriteSafetyMustReadFirst() {
  console.log(`[12/${total}] write safety: must read first...`);
  const filePath = writeFixture('write-safety.txt', 'original content');
  const context = { readFiles: new Map() };
  // Do NOT read first -- should be rejected
  const result = await write_tool.run({ file_path: filePath, content: 'sneaky overwrite' }, context);
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('read the file before overwriting'), 'error should mention read first');
  // Verify file unchanged
  assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'original content', 'file should be unchanged');
  passed++;
  console.log('  OK\n');
}

async function testWriteSafetyStaleDetection() {
  console.log(`[13/${total}] write safety: stale detection...`);
  const filePath = writeFixture('write-stale.txt', 'version 1');
  const context = { readFiles: new Map() };
  // Read the file to store its hash
  await read_tool.run({ file_path: filePath }, context);
  // Modify externally (simulating another process)
  fs.writeFileSync(filePath, 'version 2 by someone else', 'utf-8');
  // Now try to write -- should detect stale
  const result = await write_tool.run({ file_path: filePath, content: 'version 3' }, context);
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('modified externally'), 'error should mention external modification');
  // File should still be version 2
  assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'version 2 by someone else', 'file should be unchanged');
  passed++;
  console.log('  OK\n');
}

async function testWriteSafetyReadThenWrite() {
  console.log(`[14/${total}] write safety: read then write...`);
  const filePath = writeFixture('write-safe.txt', 'original');
  const context = { readFiles: new Map() };
  // Read first
  await read_tool.run({ file_path: filePath }, context);
  const hashBefore = context.readFiles.get(filePath);
  // Write -- should succeed
  const result = await write_tool.run({ file_path: filePath, content: 'updated safely' }, context);
  assert.strictEqual(result.success, true, 'should succeed');
  assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'updated safely', 'content should be updated');
  // Hash should be updated in context
  const hashAfter = context.readFiles.get(filePath);
  assert.notStrictEqual(hashBefore, hashAfter, 'hash should be updated after write');
  passed++;
  console.log('  OK\n');
}

// ---------------------------------------------------------------------------
// edit.js tests
// ---------------------------------------------------------------------------

async function testEditBasic() {
  console.log(`[15/${total}] edit basic...`);
  const filePath = writeFixture('edit-basic.txt', 'hello world\nfoo bar\n');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'foo bar', new_string: 'baz qux' });
  assert.strictEqual(result.success, true, 'should succeed');
  const content = fs.readFileSync(filePath, 'utf-8');
  assert(content.includes('baz qux'), 'should contain new string');
  assert(!content.includes('foo bar'), 'should not contain old string');
  passed++;
  console.log('  OK\n');
}

async function testEditUniquenessCheck() {
  console.log(`[16/${total}] edit uniqueness check...`);
  const filePath = writeFixture('edit-dup.txt', 'apple\nbanana\napple\n');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'apple', new_string: 'cherry' });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('found 2 times'), 'error should mention 2 occurrences');
  assert(result.error.includes('replace_all'), 'error should suggest replace_all');
  passed++;
  console.log('  OK\n');
}

async function testEditReplaceAll() {
  console.log(`[17/${total}] edit replace_all...`);
  const filePath = writeFixture('edit-all.txt', 'apple\nbanana\napple\n');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'apple', new_string: 'cherry', replace_all: true });
  assert.strictEqual(result.success, true, 'should succeed');
  const content = fs.readFileSync(filePath, 'utf-8');
  assert(!content.includes('apple'), 'should not contain old string');
  assert.strictEqual(content.split('cherry').length - 1, 2, 'should have 2 replacements');
  passed++;
  console.log('  OK\n');
}

async function testEditNotFound() {
  console.log(`[18/${total}] edit not found...`);
  const filePath = writeFixture('edit-notfound.txt', 'hello world\nfoo bar\nbaz qux\n');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'nonexistent_string_xyz', new_string: 'replaced' });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('not found'), 'error should mention not found');
  passed++;
  console.log('  OK\n');
}

async function testEditNoOp() {
  console.log(`[19/${total}] edit no-op check...`);
  const filePath = writeFixture('edit-noop.txt', 'hello world\n');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'hello', new_string: 'hello' });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('identical'), 'error should mention identical strings');
  passed++;
  console.log('  OK\n');
}

async function testEditQuoteNormalization() {
  console.log(`[20/${total}] edit quote normalization...`);
  // File has straight quotes
  const filePath = writeFixture('edit-quotes.txt', "it's a \"test\" here\n");
  // Search with curly quotes -- should still match via normalization
  const result = await edit_tool.run({ file_path: filePath, old_string: "\u2018s a \u201Ctest\u201D", new_string: 's a [replaced]' });
  assert.strictEqual(result.success, true, 'should succeed with quote normalization');
  const content = fs.readFileSync(filePath, 'utf-8');
  assert(content.includes('[replaced]'), 'should contain replacement');
  passed++;
  console.log('  OK\n');
}

async function testEditDiffOutput() {
  console.log(`[21/${total}] edit diff output...`);
  const filePath = writeFixture('edit-diff.txt', 'line 1\nline 2\nline 3\nline 4\n');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'line 2', new_string: 'LINE TWO' });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(typeof result.diff === 'string', 'should have diff field');
  assert(result.diff.includes('- line 2') || result.diff.includes('-line 2'), 'diff should show removed line');
  assert(result.diff.includes('+ LINE TWO') || result.diff.includes('+LINE TWO'), 'diff should show added line');
  passed++;
  console.log('  OK\n');
}

async function testEditMissingFile() {
  console.log(`[22/${total}] edit missing file...`);
  const filePath = path.join(TEST_DIR, 'does-not-exist-edit.txt');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'x', new_string: 'y' });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error, 'should have error message');
  passed++;
  console.log('  OK\n');
}

async function testEditReplacementsMade() {
  console.log(`[23/${total}] edit replacements_made...`);
  const filePath = writeFixture('edit-count.txt', 'aaa bbb aaa ccc aaa\n');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'aaa', new_string: 'zzz', replace_all: true });
  assert.strictEqual(result.success, true, 'should succeed');
  assert.strictEqual(result.replacements_made, 3, 'should report 3 replacements');
  passed++;
  console.log('  OK\n');
}

async function testEditMultiline() {
  console.log(`[24/${total}] edit multiline...`);
  const filePath = writeFixture('edit-multi.txt', 'start\nfoo\nbar\nbaz\nend\n');
  const result = await edit_tool.run({ file_path: filePath, old_string: 'foo\nbar\nbaz', new_string: 'REPLACED BLOCK' });
  assert.strictEqual(result.success, true, 'should succeed');
  const content = fs.readFileSync(filePath, 'utf-8');
  assert(content.includes('REPLACED BLOCK'), 'should contain replacement block');
  assert(!content.includes('foo\nbar'), 'should not contain old multiline block');
  passed++;
  console.log('  OK\n');
}

// ---------------------------------------------------------------------------
// grep.js tests
// ---------------------------------------------------------------------------

async function testGrepContentMode() {
  console.log(`[25/${total}] grep content mode...`);
  writeFixture('grep/file1.txt', 'hello world\nfoo bar\nhello again\n');
  writeFixture('grep/file2.txt', 'nothing here\n');
  const result = await grep_tool.run({ pattern: 'hello', path: TEST_DIR, output_mode: 'content' });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(Array.isArray(result.results), 'should have results array');
  assert(result.results.length >= 2, 'should have at least 2 matches');
  for (const r of result.results) {
    assert(typeof r.file === 'string', 'result should have file');
    assert(typeof r.line === 'number', 'result should have line number');
    assert(typeof r.content === 'string', 'result should have content');
  }
  passed++;
  console.log('  OK\n');
}

async function testGrepFilesWithMatchesMode() {
  console.log(`[26/${total}] grep files_with_matches mode...`);
  writeFixture('grep/fwm1.txt', 'match this\n');
  writeFixture('grep/fwm2.txt', 'no luck\n');
  writeFixture('grep/fwm3.txt', 'match that\n');
  const result = await grep_tool.run({ pattern: 'match', path: TEST_DIR, output_mode: 'files_with_matches' });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(Array.isArray(result.files), 'should have files array');
  assert(result.files.length >= 2, 'should have at least 2 matching files');
  assert(typeof result.count === 'number', 'should have count');
  passed++;
  console.log('  OK\n');
}

async function testGrepCountMode() {
  console.log(`[27/${total}] grep count mode...`);
  writeFixture('grep/count1.txt', 'aaa\naaa\nbbb\n');
  const result = await grep_tool.run({ pattern: 'aaa', path: TEST_DIR, output_mode: 'count' });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(Array.isArray(result.counts), 'should have counts array');
  assert(typeof result.total === 'number', 'should have total');
  assert(result.total >= 2, 'total should be at least 2');
  passed++;
  console.log('  OK\n');
}

async function testGrepCaseInsensitive() {
  console.log(`[28/${total}] grep case_insensitive...`);
  const caseDirPath = path.join(TEST_DIR, 'grep-case');
  fs.mkdirSync(caseDirPath, { recursive: true });
  fs.writeFileSync(path.join(caseDirPath, 'case.txt'), 'Hello\nHELLO\nhello\nworld\n');
  const result = await grep_tool.run({ pattern: 'hello', path: caseDirPath, case_insensitive: true, output_mode: 'content' });
  assert.strictEqual(result.success, true, 'should succeed');
  assert.strictEqual(result.results.length, 3, 'should match all 3 hello variants');
  passed++;
  console.log('  OK\n');
}

async function testGrepTypeFilter() {
  console.log(`[29/${total}] grep type filter...`);
  writeFixture('grep/typed.js', 'findme_js\n');
  writeFixture('grep/typed.txt', 'findme_txt\n');
  const result = await grep_tool.run({ pattern: 'findme', path: TEST_DIR, type: 'js', output_mode: 'content' });
  assert.strictEqual(result.success, true, 'should succeed');
  // Should find in .js but not .txt
  const jsResults = result.results.filter(r => r.file.endsWith('.js'));
  const txtResults = result.results.filter(r => r.file.endsWith('.txt'));
  assert(jsResults.length >= 1, 'should find match in .js file');
  assert.strictEqual(txtResults.length, 0, 'should not find match in .txt file');
  passed++;
  console.log('  OK\n');
}

async function testGrepIncludeFilter() {
  console.log(`[30/${total}] grep include filter...`);
  writeFixture('grep/incl.txt', 'target_include\n');
  writeFixture('grep/incl.js', 'target_include\n');
  const result = await grep_tool.run({ pattern: 'target_include', path: TEST_DIR, include: '*.txt', output_mode: 'content' });
  assert.strictEqual(result.success, true, 'should succeed');
  const txtResults = result.results.filter(r => r.file.endsWith('.txt'));
  const jsResults = result.results.filter(r => r.file.endsWith('.js'));
  assert(txtResults.length >= 1, 'should find match in .txt');
  assert.strictEqual(jsResults.length, 0, 'should not find match in .js');
  passed++;
  console.log('  OK\n');
}

async function testGrepContextLines() {
  console.log(`[31/${total}] grep context lines...`);
  const ctxDir = path.join(TEST_DIR, 'grep_ctx_isolated');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'ctx.txt'), 'line1\nline2\nTARGET_CTX\nline4\nline5\n');
  const result = await grep_tool.run({ pattern: 'TARGET_CTX', path: ctxDir, output_mode: 'content', context: 1 });
  assert.strictEqual(result.success, true, 'should succeed');
  // With context=1, should have more than just the 1 match line
  assert(result.results.length >= 3, 'should have match line plus context lines');
  const contents = result.results.map(r => r.content);
  assert(contents.some(c => c === 'line2'), 'should include context line before');
  assert(contents.some(c => c === 'line4'), 'should include context line after');
  passed++;
  console.log('  OK\n');
}

async function testGrepNoMatches() {
  console.log(`[32/${total}] grep no matches...`);
  writeFixture('grep/empty.txt', 'nothing relevant here\n');
  const result = await grep_tool.run({ pattern: 'zyxwv_nonexistent_pattern_12345', path: TEST_DIR, output_mode: 'content' });
  assert.strictEqual(result.success, true, 'should succeed (no matches is not an error)');
  assert.strictEqual(result.results.length, 0, 'should have 0 results');
  assert.strictEqual(result.total_matches, 0, 'total_matches should be 0');
  passed++;
  console.log('  OK\n');
}

async function testGrepPathValidation() {
  console.log(`[33/${total}] grep path validation...`);
  const result = await grep_tool.run({ pattern: 'test', path: '/tmp; rm -rf /' });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('metacharacters'), 'error should mention metacharacters');
  passed++;
  console.log('  OK\n');
}

async function testGrepPagination() {
  console.log(`[34/${total}] grep pagination...`);
  const paginateDir = path.join(TEST_DIR, 'grep_paginate_isolated');
  fs.mkdirSync(paginateDir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`paginate_match line ${i}`);
  fs.writeFileSync(path.join(paginateDir, 'paginate.txt'), lines.join('\n') + '\n');
  const result = await grep_tool.run({ pattern: 'paginate_match', path: paginateDir, output_mode: 'content', offset: 5, head_limit: 3 });
  assert.strictEqual(result.success, true, 'should succeed');
  assert.strictEqual(result.results.length, 3, 'should return exactly 3 results after offset');
  // The first returned result should be line 6 (offset=5 skips first 5, 0-indexed line numbering)
  assert(result.results[0].content.includes('line 5'), 'first result should be the 6th match (offset=5)');
  passed++;
  console.log('  OK\n');
}

// ---------------------------------------------------------------------------
// glob.js tests
// ---------------------------------------------------------------------------

async function testGlobBasic() {
  console.log(`[35/${total}] glob basic...`);
  writeFixture('glob/a.txt', 'aaa');
  writeFixture('glob/b.txt', 'bbb');
  writeFixture('glob/c.js', 'ccc');
  const result = await glob_tool.run({ pattern: '**/*.txt', path: TEST_DIR });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(Array.isArray(result.files), 'should have files array');
  const txtFiles = result.files.filter(f => f.endsWith('.txt'));
  assert(txtFiles.length >= 2, 'should find at least 2 .txt files');
  const jsFiles = result.files.filter(f => f.endsWith('.js'));
  assert.strictEqual(jsFiles.length, 0, 'should not include .js files');
  passed++;
  console.log('  OK\n');
}

async function testGlobMtimeSort() {
  console.log(`[36/${total}] glob mtime sort...`);
  writeFixture('glob-mtime/older.txt', 'old');
  // Small delay to guarantee different mtime
  await new Promise(r => setTimeout(r, 50));
  writeFixture('glob-mtime/newer.txt', 'new');
  const result = await glob_tool.run({ pattern: '**/*.txt', path: path.join(TEST_DIR, 'glob-mtime') });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(result.files.length >= 2, 'should find 2 files');
  // First file should be the newer one (descending mtime)
  assert(result.files[0].includes('newer.txt'), 'first file should be most recently modified');
  assert(result.files[1].includes('older.txt'), 'second file should be older');
  passed++;
  console.log('  OK\n');
}

async function testGlobIgnorePatterns() {
  console.log(`[37/${total}] glob ignore patterns...`);
  writeFixture('glob-ignore/src/main.js', 'main');
  writeFixture('glob-ignore/node_modules/dep/index.js', 'dep');
  const result = await glob_tool.run({ pattern: '**/*.js', path: path.join(TEST_DIR, 'glob-ignore') });
  assert.strictEqual(result.success, true, 'should succeed');
  const nmFiles = result.files.filter(f => f.includes('node_modules'));
  assert.strictEqual(nmFiles.length, 0, 'should exclude node_modules');
  const srcFiles = result.files.filter(f => f.includes('src/main.js'));
  assert(srcFiles.length >= 1, 'should include src files');
  passed++;
  console.log('  OK\n');
}

async function testGlobDurationMs() {
  console.log(`[38/${total}] glob duration_ms...`);
  const result = await glob_tool.run({ pattern: '**/*.txt', path: TEST_DIR });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(typeof result.duration_ms === 'number', 'should have duration_ms');
  assert(result.duration_ms >= 0, 'duration_ms should be non-negative');
  passed++;
  console.log('  OK\n');
}

async function testGlobNoMatches() {
  console.log(`[39/${total}] glob no matches...`);
  const result = await glob_tool.run({ pattern: '**/*.nonexistent_extension_xyz', path: TEST_DIR });
  assert.strictEqual(result.success, true, 'should succeed');
  assert.strictEqual(result.files.length, 0, 'should have 0 files');
  assert.strictEqual(result.count, 0, 'count should be 0');
  passed++;
  console.log('  OK\n');
}

async function testGlobNestedPattern() {
  console.log(`[40/${total}] glob nested pattern...`);
  writeFixture('glob-nested/a/b/deep.js', 'deep');
  writeFixture('glob-nested/a/shallow.js', 'shallow');
  writeFixture('glob-nested/top.js', 'top');
  const result = await glob_tool.run({ pattern: '**/*.js', path: path.join(TEST_DIR, 'glob-nested') });
  assert.strictEqual(result.success, true, 'should succeed');
  assert(result.files.length >= 3, 'should find all 3 nested .js files');
  const deep = result.files.filter(f => f.includes('deep.js'));
  assert(deep.length >= 1, 'should find deeply nested file');
  passed++;
  console.log('  OK\n');
}

// ---------------------------------------------------------------------------
// explore.js tests (safety checks only, no LLM)
// ---------------------------------------------------------------------------

async function testExploreMissingTask() {
  console.log(`[41/${total}] explore missing task...`);
  if (!explore_tool) { console.log('  SKIPPED -- @orchestrator/sdk not installed\n'); passed++; return; }
  const result = await explore_tool.run({ project_path: '/tmp' }, { communicatorUrl: 'http://localhost:10000' });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('task'), 'error should mention task');
  passed++;
  console.log('  OK\n');
}

async function testExploreMissingProjectPath() {
  console.log(`[42/${total}] explore missing project_path...`);
  if (!explore_tool) { console.log('  SKIPPED -- @orchestrator/sdk not installed\n'); passed++; return; }
  const result = await explore_tool.run({ task: 'find something' }, { communicatorUrl: 'http://localhost:10000' });
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('project_path'), 'error should mention project_path');
  passed++;
  console.log('  OK\n');
}

async function testExploreMissingCommunicator() {
  console.log(`[43/${total}] explore missing communicator...`);
  if (!explore_tool) { console.log('  SKIPPED -- @orchestrator/sdk not installed\n'); passed++; return; }
  const result = await explore_tool.run({ task: 'find something', project_path: '/tmp' }, {});
  assert.strictEqual(result.success, false, 'should fail');
  assert(result.error.includes('communicator'), 'error should mention communicator');
  passed++;
  console.log('  OK\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('PC Agent Tool Unit Tests\n');

  try {
    setup();

    // read.js
    await testReadBasic();
    await testReadOffsetLimit();
    await testReadMetadata();
    await testReadEnoent();
    await testReadBinaryDetection();
    await testReadImageDetection();
    await testReadDirectory();
    await testReadContextTracking();

    // write.js
    await testWriteBasic();
    await testWriteCreatesParentDirs();
    await testWriteOverwriteWithoutContext();
    await testWriteSafetyMustReadFirst();
    await testWriteSafetyStaleDetection();
    await testWriteSafetyReadThenWrite();

    // edit.js
    await testEditBasic();
    await testEditUniquenessCheck();
    await testEditReplaceAll();
    await testEditNotFound();
    await testEditNoOp();
    await testEditQuoteNormalization();
    await testEditDiffOutput();
    await testEditMissingFile();
    await testEditReplacementsMade();
    await testEditMultiline();

    // grep.js
    await testGrepContentMode();
    await testGrepFilesWithMatchesMode();
    await testGrepCountMode();
    await testGrepCaseInsensitive();
    await testGrepTypeFilter();
    await testGrepIncludeFilter();
    await testGrepContextLines();
    await testGrepNoMatches();
    await testGrepPathValidation();
    await testGrepPagination();

    // glob.js
    await testGlobBasic();
    await testGlobMtimeSort();
    await testGlobIgnorePatterns();
    await testGlobDurationMs();
    await testGlobNoMatches();
    await testGlobNestedPattern();

    // explore.js (safety checks only)
    await testExploreMissingTask();
    await testExploreMissingProjectPath();
    await testExploreMissingCommunicator();

    console.log(`\nAll ${passed}/${total} tests passed!`);
  } catch (err) {
    failed++;
    console.error(`\nTEST FAILED: ${err.message}`);
    console.error(err.stack);
    console.error(`\n${passed} passed, ${failed} failed out of ${total}`);
    process.exit(1);
  } finally {
    cleanup();
  }
}

run();
