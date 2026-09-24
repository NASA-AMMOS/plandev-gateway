import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DbMerlin } from '../src/packages/db/db';
import { removeUploadedFile } from '../src/packages/files/store';

const { fileStore } = vi.hoisted(() => ({ fileStore: { path: '' } }));

vi.mock('../src/util/fileParser', () => ({
  get FILE_PATH() {
    return fileStore.path;
  },
}));

const query = vi.fn();
vi.spyOn(DbMerlin, 'getDb').mockReturnValue({ query } as any);

const file = { id: 42, name: 'plan-transfer-results-1-abc.json' };

beforeEach(() => {
  fileStore.path = mkdtempSync(join(tmpdir(), 'file-store-test-'));
  writeFileSync(join(fileStore.path, file.name), '{}');
  query.mockReset();
});

describe('removeUploadedFile', () => {
  test('deletes the row, then the file', async () => {
    query.mockResolvedValue({ rowCount: 1 });

    await removeUploadedFile(file);

    expect(query).toHaveBeenCalledWith(expect.stringMatching(/delete from merlin.uploaded_file/), [file.id]);
    expect(existsSync(join(fileStore.path, file.name))).toBe(false);
  });

  test('keeps a file whose row cannot be deleted, e.g. one a model still references', async () => {
    query.mockRejectedValue(new Error('violates foreign key constraint "mission_model_references_file"'));

    await expect(removeUploadedFile(file)).resolves.toBeUndefined();

    expect(existsSync(join(fileStore.path, file.name))).toBe(true);
  });

  test('a file already gone from disk is not an error', async () => {
    query.mockResolvedValue({ rowCount: 1 });

    await expect(removeUploadedFile({ ...file, name: 'missing.json' })).resolves.toBeUndefined();
  });
});
