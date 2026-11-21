# Cove Server (Nov 20, 2026). One engine for Docker, Windows and Mac: cove-api also serves the app and passes Jellyfin and
# Kavita through (api/front.py), so there's no nginx. Build with build.py, which copies the current code into src\ first.
FROM python:3.13-alpine
RUN apk add --no-cache tzdata
COPY src/web /srv/web
COPY src/books /srv/books
COPY src/api /app
COPY setup /srv/setup
COPY cove/entrypoint.sh /cove/entrypoint.sh
RUN sed -i 's/\r$//' /cove/entrypoint.sh && chmod +x /cove/entrypoint.sh
ENV PYTHONDONTWRITEBYTECODE=1 COVE_FRONT=1 COVE_PORT=80 COVE_DATA=/data COVE_WEB=/srv/web COVE_BOOKS=/srv/books COVE_SETUP=/srv/setup
VOLUME /data
EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1/cove-api/setup/status || exit 1
ENTRYPOINT ["/cove/entrypoint.sh"]
