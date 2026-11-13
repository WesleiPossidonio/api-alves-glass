#!/bin/sh
set -eu

# Run only after explicit authorization to create disposable local test resources.
# Generates unique credentials but does not start Docker, create buckets or change policies.
umask 077
directory="$(dirname "$0")"
compose_env="$directory/.env.minio-test"
app_env="$directory/.env.minio-app-test"

if [ -e "$compose_env" ] || [ -e "$app_env" ]; then
  echo "Refusing to overwrite existing MinIO test env file" >&2
  exit 1
fi

root_user="f003minio$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
root_password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
cat > "$compose_env" <<EOF
F003_IT_MINIO_ROOT_USER=$root_user
F003_IT_MINIO_ROOT_PASSWORD=$root_password
F003_IT_MINIO_REGION=us-east-1
EOF
cat > "$app_env" <<EOF
MINIO_ENDPOINT=127.0.0.1
MINIO_PORT=59000
MINIO_USE_SSL=false
MINIO_REGION=us-east-1
MINIO_ACCESS_KEY=$root_user
MINIO_SECRET_KEY=$root_password
MINIO_PUBLIC_BUCKET=feature003-public-test
MINIO_PRIVATE_BUCKET=feature003-private-test
EOF

printf 'Generated disposable MinIO credentials in ignored local files; no service or bucket was created.\n'