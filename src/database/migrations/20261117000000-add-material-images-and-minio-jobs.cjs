'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction()
    try {
      await queryInterface.addColumn('materials', 'image_bucket', { type: Sequelize.STRING(255), allowNull: true }, { transaction })
      await queryInterface.addColumn('materials', 'image_object_key', { type: Sequelize.TEXT, allowNull: true }, { transaction })
      await queryInterface.addColumn('materials', 'image_visibility', { type: Sequelize.STRING(8), allowNull: true }, { transaction })
      await queryInterface.sequelize.query(`
        ALTER TABLE materials
          ADD CONSTRAINT materials_image_reference_complete_ck CHECK (
            (image_bucket IS NULL AND image_object_key IS NULL AND image_visibility IS NULL)
            OR (length(btrim(image_bucket)) > 0 AND length(btrim(image_object_key)) > 0
                AND image_visibility IN ('public','private'))
          );
        CREATE INDEX materials_image_object_reference_idx
          ON materials (image_bucket,image_object_key) WHERE image_object_key IS NOT NULL;
        CREATE TABLE minio_cleanup_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          bucket varchar(255) NOT NULL CHECK (length(btrim(bucket)) > 0),
          object_key text NOT NULL CHECK (length(btrim(object_key)) > 0),
          status varchar(16) NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING','PROCESSING','RETRY','DONE','BLOCKED')),
          attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          last_error text,
          next_attempt_at timestamptz NOT NULL DEFAULT now(),
          locked_at timestamptz,
          locked_by varchar(128),
          processed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK ((status = 'PROCESSING') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
          CHECK ((status = 'DONE') = (processed_at IS NOT NULL))
        );
        CREATE INDEX minio_cleanup_jobs_ready_idx ON minio_cleanup_jobs (next_attempt_at,created_at,id)
          WHERE status IN ('PENDING','RETRY');
        CREATE INDEX minio_cleanup_jobs_lease_idx ON minio_cleanup_jobs (locked_at,id) WHERE status='PROCESSING';
        CREATE UNIQUE INDEX minio_cleanup_jobs_active_object_idx ON minio_cleanup_jobs (bucket,object_key)
          WHERE status IN ('PENDING','PROCESSING','RETRY','BLOCKED');
        CREATE TABLE minio_upload_intents (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          bucket varchar(255) NOT NULL CHECK (length(btrim(bucket)) > 0),
          object_key text NOT NULL CHECK (length(btrim(object_key)) > 0),
          status varchar(16) NOT NULL DEFAULT 'UPLOADING' CHECK (status IN ('UPLOADING','COMMITTED','ABANDONED')),
          created_by uuid NOT NULL REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
          last_error text,
          lease_expires_at timestamptz NOT NULL,
          completed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (bucket,object_key),
          CHECK ((status IN ('COMMITTED','ABANDONED')) = (completed_at IS NOT NULL))
        );
        CREATE INDEX minio_upload_intents_expired_idx ON minio_upload_intents (lease_expires_at,created_at,id)
          WHERE status='UPLOADING';
        CREATE INDEX minio_upload_intents_object_idx ON minio_upload_intents (bucket,object_key,status);
      `, { transaction })
      await transaction.commit()
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction()
    try {
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM minio_cleanup_jobs WHERE status <> 'DONE') THEN
            RAISE EXCEPTION 'refusing rollback with unfinished MinIO cleanup jobs';
          END IF;
          IF EXISTS (SELECT 1 FROM minio_upload_intents WHERE status = 'UPLOADING') THEN
            RAISE EXCEPTION 'refusing rollback with active MinIO upload intents';
          END IF;
        END $$;
        DROP TABLE minio_cleanup_jobs;
        DROP TABLE minio_upload_intents;
        DROP INDEX materials_image_object_reference_idx;
        ALTER TABLE materials DROP CONSTRAINT materials_image_reference_complete_ck;
      `, { transaction })
      await queryInterface.removeColumn('materials', 'image_visibility', { transaction })
      await queryInterface.removeColumn('materials', 'image_object_key', { transaction })
      await queryInterface.removeColumn('materials', 'image_bucket', { transaction })
      await transaction.commit()
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  },
}