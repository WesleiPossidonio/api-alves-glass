import crypto from "crypto";
import path from "path";

import minioClient from "../../config/minio.js";

class StorageService {

    async upload(file, folder = "") {
        const extension = path.extname(file.originalname);

        const filename =
            `${crypto.randomUUID()}${extension}`;

        const objectName =
            folder
            ? `${folder}/${filename}`
            : filename;

        await minioClient.putObject(
            process.env.MINIO_BUCKET,
            objectName,
            file.buffer,
            file.size,
            {
                "Content-Type": file.mimetype
            }
        );

        return objectName;
    }

}

export default new StorageService();
