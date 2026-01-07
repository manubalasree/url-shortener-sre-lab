# Use official Shlink image as base
FROM shlinkio/shlink:4.6.0

# Build arguments for flexibility
ARG BUILD_DATE
ARG VCS_REF
ARG VERSION=4.6.0

# Metadata labels
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.title="Shlink with phpredis" \
      org.opencontainers.image.description="Shlink URL shortener with phpredis extension for Redis Sentinel support" \
      org.opencontainers.image.url="https://github.com/${GITHUB_REPOSITORY}" \
      org.opencontainers.image.source="https://github.com/${GITHUB_REPOSITORY}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.vendor="manubalasree" \
      org.opencontainers.image.licenses="MIT" \
      maintainer="manubalasree"

# Switch to root to install packages
USER root

# Install build dependencies and phpredis extension
RUN apk add --no-cache --virtual .build-deps \
    autoconf \
    g++ \
    make \
    php83-dev \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && apk del .build-deps \
    && rm -rf /tmp/pear

# Verify phpredis is installed
RUN php -m | grep redis

# Note: User context inherited from base image
# Base image will set appropriate user at runtime

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/rest/health || exit 1
