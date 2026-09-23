import { writeFile } from 'fs/promises';
import { customAlphabet } from 'nanoid';
import path, { parse } from 'path';
import { DbMerlin } from '../db/db.js';
import { FILE_PATH } from '../../util/fileParser.js';

const nanoId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 14);

/**
 * Makes a file store name for an uploaded file, e.g. `model.json` -> `model-1700000000000-AbC123.json`.
 */
export function uniqueFileName(originalname: string): string {
  const { ext, name } = parse(originalname);
  return `${name}-${Date.now()}-${nanoId()}${ext}`;
}

/**
 * Records a file already present in the file store as a `merlin.uploaded_file`.
 */
export async function insertUploadedFile(fileName: string): Promise<number | null> {
  // Note because name and path are different types, we need to bind the filename variable
  // twice so the query casts it appropriately to each type.
  const { rows } = await DbMerlin.getDb().query(
    `
      insert into merlin.uploaded_file (name, path)
      values ($1, $2)
      returning id;
    `,
    [fileName, fileName],
  );

  const [row] = rows;
  return row ? row.id : null;
}

/**
 * Writes `contents` into the file store and records it as a `merlin.uploaded_file`.
 */
export async function storeUploadedFile(originalname: string, contents: string): Promise<{ id: number; name: string }> {
  const name = uniqueFileName(originalname);
  await writeFile(path.join(FILE_PATH, name), contents);

  const id = await insertUploadedFile(name);
  if (id === null) {
    throw new Error(`Failed to record uploaded file ${name}.`);
  }

  return { id, name };
}

/**
 * Soft-deletes an uploaded file, the same way `DELETE /file/:id` does.
 */
export async function markUploadedFileDeleted(id: number): Promise<void> {
  await DbMerlin.getDb().query(
    `
      update merlin.uploaded_file
      set deleted_date = $1
      where id = $2;
    `,
    [new Date(), id],
  );
}
