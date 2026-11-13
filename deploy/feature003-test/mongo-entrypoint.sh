#!/bin/sh
set -eu
key=/run/mongodb-key/internal-auth-key
printf '%s' "$MONGO_INITDB_ROOT_PASSWORD" > "$key"
chmod 400 "$key"
chown mongodb:mongodb "$key"
exec gosu mongodb docker-entrypoint.sh mongod --replSet feature003-rs --bind_ip_all --keyFile "$key"