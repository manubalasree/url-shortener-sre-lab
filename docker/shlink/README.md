# Shlink with phpredis Extension

Custom Shlink image with phpredis extension for Redis Sentinel support.

## Why This Custom Image?

The official Shlink image uses the Predis PHP library, which has compatibility issues with Redis Sentinel deployments. This custom image adds the phpredis extension, which natively supports:

- Redis Sentinel for high availability
- Better performance (native C extension vs pure PHP)
- Improved connection handling and failover

## Features

- Based on official `shlinkio/shlink:4.6.0`
- phpredis extension compiled and enabled
- Maintains all original Shlink functionality
- Same security posture (runs as non-root user)
- Multi-architecture support (amd64, arm64)

## Usage

### Pull from GitHub Container Registry
```bash
docker pull ghcr.io/manubalasree/shlink-phpredis:latest
```

### Run with Redis Sentinel
```bash
docker run -d \
  -e DEFAULT_DOMAIN=short.example.com \
  -e IS_HTTPS_ENABLED=false \
  -e DB_DRIVER=postgres \
  -e DB_HOST=postgres.example.com \
  -e DB_NAME=shlink \
  -e DB_USER=shlink \
  -e DB_PASSWORD=secret \
  -e REDIS_SERVERS=redis-sentinel.example.com:26379 \
  -e REDIS_SENTINEL_SERVICE=mymaster \
  ghcr.io/manubalasree/shlink-phpredis:latest
```

### Kubernetes Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shlink
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: shlink
        image: ghcr.io/manubalasree/shlink-phpredis:4.6.0
        env:
        - name: REDIS_SERVERS
          value: "rfs-shlink-redis.redis.svc.cluster.local:26379"
        - name: REDIS_SENTINEL_SERVICE
          value: "mymaster"
```

## Building Locally
```bash
cd docker/shlink
docker build -t shlink-phpredis:local .
docker run --rm shlink-phpredis:local php -m | grep redis
```

## CI/CD

This image is automatically built and pushed to GitHub Container Registry via GitHub Actions on:
- Push to `main` branch
- Changes to `docker/shlink/` directory
- Manual workflow dispatch

## Verification

Verify phpredis is installed:
```bash
docker run --rm ghcr.io/manubalasree/shlink-phpredis:latest php -m | grep redis
```

Expected output: `redis`

## Maintenance

This image tracks the official Shlink releases. To update:

1. Update `FROM shlinkio/shlink:X.Y.Z` in Dockerfile
2. Update version tags in workflow
3. Push to trigger build

## License

Based on [Shlink](https://github.com/shlinkio/shlink) which is MIT licensed.
