import type { Express } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { getEnv } from '../../env.js';
import getLogger from '../../logger.js';
import { auth } from '../auth/middleware.js';
import { DbMerlin } from '../db/db.js';
import { FILE_PATH } from '../../util/fileParser.js';
import { insertUploadedFile, uniqueFileName } from './store.js';

const logger = getLogger('packages/files/files');

export default (app: Express) => {
  const { RATE_LIMITER_FILES_MAX } = getEnv();

  const filesLimiter = rateLimit({
    legacyHeaders: false,
    max: RATE_LIMITER_FILES_MAX,
    standardHeaders: true,
    windowMs: 15 * 60 * 1000, // 15 minutes
  });

  const db = DbMerlin.getDb();
  const fileStorePath = 'files';

  const storage = multer.diskStorage({
    destination(_, __, cb) {
      cb(null, fileStorePath);
    },
    filename(_, file, cb) {
      cb(null, uniqueFileName(file.originalname));
    },
  });

  const upload = multer({ storage });

  /**
   * @swagger
   * /file/{id}:
   *   delete:
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - description: ID of the file to delete
   *         in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: number
   *     responses:
   *       200:
   *         description: DeleteFileResponse
   *     summary: Delete a file from the filesystem
   *     tags:
   *       - Files
   */
  app.delete('/file/:id', filesLimiter, auth, async (req, res) => {
    const { params } = req;
    const { id } = params;

    try {
      const deleted_date = new Date();
      const { rowCount } = await db.query(
        `
        update merlin.uploaded_file
        set deleted_date = $1
        where id = $2;
      `,
        [deleted_date, id],
      );

      if (rowCount && rowCount > 0) {
        logger.info(`DELETE /file: Marked file as deleted in the database: ${id}`);
      } else {
        logger.info(`DELETE /file: No file was marked as deleted in the database`);
      }

      res.json({ id, success: true });
    } catch (error: any) {
      logger.error(error);
      res.status(404).json({ message: error.message, success: false });
    }
  });

  /**
   * @swagger
   * /file/{id}:
   *   get:
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - description: ID of the file
   *         in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: number
   *     produces:
   *       - application/octet-stream
   *     responses:
   *       200:
   *         description: GetFileResponse
   *     summary: Get the file with the associated ID.
   *     tags:
   *       - Files
   */
  app.get('/file/:id', filesLimiter, auth, async (req, res) => {
    const { params } = req;
    const { id } = params;
    const noFileFoundError = `No file was found with id: ${id}`;

    try {
      const { rows, rowCount } = await db.query(
        `
        select *
        from merlin.uploaded_file
        where id = $1
        and deleted_date is null;
      `,
        [id],
      );

      if (rowCount && rowCount > 0) {
        const [row] = rows;
        const { name } = row;

        const filePath = path.join(FILE_PATH, name);

        res.sendFile(filePath, err => {
          if (err) {
            logger.info(`GET /file/{id}: ${noFileFoundError}`);
            res.status(404).json(err.message);
          }
        });
      } else {
        res.status(404).json(noFileFoundError);
      }
    } catch (error: any) {
      logger.error(error);
      res.status(500).json(error.message);
    }
  });

  /**
   * @swagger
   * /file:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - multipart/form-data
   *     produces:
   *       - application/json
   *     requestBody:
   *       content:
   *         multipart/form-data:
   *          schema:
   *            type: object
   *            properties:
   *              file:
   *                format: binary
   *                type: string
   *     responses:
   *       200:
   *         description: UploadFileResponse
   *     summary: Upload a file to the filesystem
   *     tags:
   *       - Files
   */
  app.post('/file', filesLimiter, auth, upload.any(), async (req, res) => {
    const [file] = req.files as Express.Multer.File[];
    const { filename } = file;

    const id = await insertUploadedFile(filename);

    if (id !== null) {
      logger.info(`POST /file: Added file to the database: ${id}`);
    } else {
      logger.info(`POST /file: No file was added to the database`);
    }

    res.json({ file, id });
  });
};
