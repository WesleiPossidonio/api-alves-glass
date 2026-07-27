import multer from "multer";

export default multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 10 * 1024 * 1024 //10MB
    }
});
