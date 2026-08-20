#!/bin/sh
chown -R node:node /app/data
exec su -s /bin/sh node -c "node dist/index.js"
