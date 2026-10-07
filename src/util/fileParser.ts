import { JSONParser } from '@streamparser/json';
import { createReadStream } from 'fs';

export const FILE_PATH = '/app/files';

/**
 * Parses an uploaded JSON file, from memory (`file.buffer`) or, for a disk-backed upload, by streaming `file.path`.
 */
export function parseJSONFile<T>(file?: Express.Multer.File): Promise<T> {
  return new Promise((resolve, reject) => {
    const jsonParser = new JSONParser({ paths: ['$.*'], stringBufferSize: undefined });
    let finalJSON: any;
    jsonParser.onToken = ({ value }) => {
      if (finalJSON === undefined) {
        if (value === '[') finalJSON = [];
        else if (value === '{') finalJSON = {};
      }
    };
    jsonParser.onValue = ({ parent }) => {
      finalJSON = parent;
    };
    jsonParser.onEnd = () => {
      resolve(finalJSON as T);
    };

    const onParseError = (e: unknown) => {
      let err = e as Error;
      console.error(err);
      if (err.message) err.message = `JSON Parse error: ${err.message}`;
      else err = new Error(`JSON Parse error: ${e}`);
      reject(err);
    };

    if (file?.buffer) {
      try {
        jsonParser.write(file.buffer);
      } catch (e) {
        onParseError(e);
      }
    } else if (file?.path) {
      const stream = createReadStream(file.path);
      stream.on('data', chunk => {
        if (jsonParser.isEnded) {
          // Trailing whitespace after the top-level value.
          return;
        }
        try {
          jsonParser.write(chunk);
        } catch (e) {
          stream.destroy();
          onParseError(e);
        }
      });
      stream.on('error', reject);
      stream.on('end', () => {
        // A complete top-level value ends the parser on its own; anything left open is a truncated file.
        if (!jsonParser.isEnded) {
          reject(new Error('JSON Parse error: Unexpected end of file'));
        }
      });
    } else {
      reject(new Error('invalid JSON file'));
    }
  });
}
