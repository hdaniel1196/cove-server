#!/bin/sh
# Cove Server in Docker: one program (cove-api with its front door). It restarts itself after setup to load the new
# settings; this loop brings it straight back.
mkdir -p /data
while true; do python -u /app/server.py; echo "Cove Server stopped, starting it again"; sleep 1; done
