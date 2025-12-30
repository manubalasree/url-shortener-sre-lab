# Shlink Integration Guide: Database, Cache, and Secrets Management

**Date**: 2025-12-29
**Component**: Shlink URL Shortener
**Version**: 4.6.0 (shlinkio/shlink:stable)

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [PostgreSQL Integration](#postgresql-integration)
4. [Redis Integration Challenges](#redis-integration-challenges)
5. [Vault Secrets Management](#vault-secrets-management)
6. [Deployment Configuration](#deployment-configuration)
7. [Istio Service Mesh Integration](#istio-service-mesh-integration)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Lessons Learned](#lessons-learned)

---

## Overview

This document captures the integration experience of deploying Shlink with:
- **PostgreSQL** (via Crunchy Data Operator) for persistent storage
- **Redis** (via Spotahome Operator) for caching and distributed locks
- **HashiCorp Vault** (via External Secrets Operator) for secrets management
- **Istio Service Mesh** for traffic management, observability, and security

### Key Takeaways

**What Works**:
- Shlink + PostgreSQL with proper schema permissions
- Vault-based secret management via External Secrets Operator
- StatefulSet DNS with headless services for Redis pods
- Istio service mesh with ingress gateway and traffic routing
- Full Shlink functionality via Istio (API, redirects, analytics)

**Current Limitations**:
- Redis integration temporarily disabled due to Predis library compatibility issues with Redis Sentinel/Failover setup
- Requires manual PostgreSQL schema permission grants

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Shlink Application                      │
│                     (3 replicas)                             │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐│
│  │   Pod 1        │  │   Pod 2        │  │   Pod 3        ││
│  │                │  │                │  │                ││
│  │ RoadRunner     │  │ RoadRunner     │  │ RoadRunner     ││
│  │ HTTP Server    │  │ HTTP Server    │  │ HTTP Server    ││
│  └────────────────┘  └────────────────┘  └────────────────┘│
└──────────┬────────────────┬─────────────────┬───────────────┘
           │                │                 │
           ├────────────────┴─────────────────┤
           │                                  │
           ▼                                  ▼
    ┌──────────────┐                  ┌──────────────────┐
    │  PostgreSQL  │                  │  HashiCorp Vault │
    │   Primary    │                  │                  │
    │              │                  │  ┌────────────┐  │
    │  (Crunchy    │                  │  │  Postgres  │  │
    │   Operator)  │◄─────────────────┼──┤  Secrets   │  │
    │              │  Credentials     │  └────────────┘  │
    └──────────────┘                  │                  │
                                      │  ┌────────────┐  │
    ┌──────────────┐                  │  │   Redis    │  │
    │    Redis     │                  │  │  Secrets   │  │
    │  Failover    │◄─────────────────┼──┤ (future)   │  │
    │              │  Credentials     │  └────────────┘  │
    │ 3x Redis     │                  └──────────────────┘
    │ 3x Sentinel  │                           ▲
    │              │                           │
    │ (Spotahome   │                  ┌────────┴─────────┐
    │  Operator)   │                  │ External Secrets │
    └──────────────┘                  │    Operator      │
                                      └──────────────────┘
```

---

## PostgreSQL Integration

### Configuration

**Environment Variables** ([deployment.yaml:32-46](kubernetes/kustomize/shlink/deployment.yaml#L32-L46)):
```yaml
- name: DB_DRIVER
  value: "postgres"
- name: DB_HOST
  value: "shlink-db-primary.postgres.svc.cluster.local"
- name: DB_PORT
  value: "5432"
- name: DB_NAME
  value: "shlink"
- name: DB_USER
  value: "shlink"
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: shlink-db-pguser-shlink
      key: password
```

### Critical Gotcha: Schema Permissions

**Problem**: Database migrations fail with permission error:
```
SQLSTATE[42501]: Insufficient privilege: 7 ERROR: permission denied for schema public
LINE 1: CREATE TABLE migrations (version VARCHAR(191) NOT NULL, exec...
```

**Root Cause**: The Crunchy Data Operator creates the `shlink` user but doesn't grant full schema permissions on the `public` schema.

**Solution**: Manual permission grant required:
```bash
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -d shlink -c "GRANT ALL ON SCHEMA public TO shlink;"
```

**Why This Happens**:
- PostgreSQL 15+ changed default permissions for the `public` schema
- Crunchy Operator doesn't automatically grant CREATE privileges to application users
- Shlink's Doctrine migrations need to create the `migrations` table and other schema objects

**Best Practice**:
- Document this step in deployment automation
- Consider creating a Kubernetes Job to apply permissions after database provisioning
- Alternative: Use PostgreSQL `ALTER DEFAULT PRIVILEGES` to grant permissions automatically

### Database Connection Testing

Verify connectivity from Shlink pod:
```bash
kubectl exec -n shlink deployment/shlink -- \
  psql -h shlink-db-primary.postgres.svc.cluster.local \
       -U shlink \
       -d shlink \
       -c "SELECT version();"
```

---

## Redis Integration Challenges

### Deployment Setup

**Redis Operator**: Spotahome Redis Operator
**CRD**: RedisFailover
**Configuration** ([redis-cluster.yaml](kubernetes/kustomize/redis/redis-cluster.yaml)):

```yaml
apiVersion: databases.spotahome.com/v1
kind: RedisFailover
metadata:
  name: shlink-redis
spec:
  sentinel:
    replicas: 3
  redis:
    replicas: 3
    storage:
      persistentVolumeClaim:
        spec:
          resources:
            requests:
              storage: 8Gi
```

**Creates**:
- 3 Redis pods in standalone mode (NOT cluster mode)
- 3 Sentinel pods for high availability
- StatefulSet: `rfr-shlink-redis` (Redis)
- Deployment: `rfs-shlink-redis` (Sentinel)

### DNS Resolution for StatefulSet Pods

**Problem**: Cannot resolve individual Redis pod names:
```
getaddrinfo for rfr-shlink-redis-0.redis.svc.cluster.local failed: Name does not resolve
```

**Root Cause**: StatefulSet pods require a headless service for DNS records.

**Solution**: Create headless service ([redis-headless-svc.yaml](kubernetes/kustomize/redis/redis-headless-svc.yaml)):
```yaml
apiVersion: v1
kind: Service
metadata:
  name: rfr-shlink-redis
  namespace: redis
spec:
  clusterIP: None  # Headless service
  ports:
  - name: redis
    port: 6379
    targetPort: 6379
  selector:
    app.kubernetes.io/component: redis
    redisfailovers.databases.spotahome.com/name: shlink-redis
```

**DNS Pattern**: `<pod-name>.<headless-service-name>.<namespace>.svc.cluster.local`

**Examples**:
- `rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local:6379`
- `rfr-shlink-redis-1.rfr-shlink-redis.redis.svc.cluster.local:6379`
- `rfr-shlink-redis-2.rfr-shlink-redis.redis.svc.cluster.local:6379`

**Verification**:
```bash
kubectl run -it --rm debug --image=busybox --restart=Never -n shlink -- \
  nslookup rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local
```

### Redis Cluster vs Sentinel vs Standalone

**Critical Understanding**:

| Mode | Description | Cluster Enabled | Use Case |
|------|-------------|----------------|----------|
| **Standalone** | Single Redis instance | `cluster_enabled:0` | Development, simple setups |
| **Sentinel** | Master-replica with automatic failover | `cluster_enabled:0` | HA without sharding |
| **Cluster** | Distributed sharding across nodes | `cluster_enabled:1` | Large-scale, multi-node |

**Verify Mode**:
```bash
kubectl exec -n redis rfr-shlink-redis-0 -- redis-cli INFO | grep cluster_enabled
# Output: cluster_enabled:0 (Sentinel/Standalone mode)
```

### Shlink + Redis Compatibility Issues

**Problem 1**: CLUSTER SLOTS command fails
```
No connections left in the pool for `CLUSTER SLOTS`
```

**Cause**: When providing multiple Redis servers to `REDIS_SERVERS`, Shlink's Predis library assumes Redis Cluster mode and tries to execute `CLUSTER SLOTS` command, which doesn't exist in Sentinel mode.

**Attempted Configuration**:
```yaml
- name: REDIS_SERVERS
  value: "rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local:6379,
          rfr-shlink-redis-1.rfr-shlink-redis.redis.svc.cluster.local:6379,
          rfr-shlink-redis-2.rfr-shlink-redis.redis.svc.cluster.local:6379"
```

**Problem 2**: NOSCRIPT error with single server
```
NOSCRIPT No matching script. Please use EVAL.
```

**Cause**: Predis tries to use `EVALSHA` for Lua scripts, but the script cache isn't synchronized across reconnections or failovers in this setup.

**Problem 3**: Sentinel configuration incompatibility
```yaml
- name: REDIS_SENTINEL_SERVICE
  value: "mymaster"
- name: REDIS_SERVERS
  value: "rfs-shlink-redis.redis.svc.cluster.local:26379"
```

**Result**: Fatal error in cache clearing:
```
Fatal error: Cannot use object of type Predis\Response\Error as array
in /etc/shlink/vendor/symfony/cache/Traits/RedisTrait.php:613
```

**Cause**: Symfony Cache component receives unexpected error response from Sentinel that it can't handle properly.

### Current Solution: Redis Disabled

**Decision**: Temporarily remove Redis configuration until compatibility is resolved.

**Impact**:
- Application runs successfully with PostgreSQL only
- All database migrations complete
- Health checks pass
- No distributed locking (single-instance locks only)
- No caching layer (impacts performance under load)
- No pub/sub for real-time updates

### Future Redis Integration Options

1. **True Redis Cluster Mode**
   - Deploy Redis in cluster mode with `cluster_enabled:1`
   - Requires minimum 6 nodes (3 masters + 3 replicas)
   - Shlink's Predis library will work correctly
   - **Trade-off**: More resource-intensive

2. **Single Redis Master Connection**
   - Connect to master pod only: `rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local:6379`
   - Sentinel handles failover automatically (DNS updates)
   - **Trade-off**: Brief downtime during failover

3. **Alternative PHP Redis Client**
   - Replace Predis with phpredis extension
   - Better Sentinel support
   - **Trade-off**: Requires custom Shlink image build

4. **External Managed Redis**
   - Use cloud provider's managed Redis (e.g., AWS ElastiCache, GCP Memorystore)
   - **Trade-off**: Cost, vendor lock-in

---

## Vault Secrets Management

### Architecture

```
External Secrets Operator
    ↓ (watches)
ExternalSecret CR
    ↓ (fetches from)
Vault (secret/postgres/shlink)
    ↓ (creates)
Kubernetes Secret (shlink-db-pguser-shlink)
    ↓ (mounted as env)
Shlink Pods
```

### Vault Deployment

**Helm Chart**: `hashicorp/vault:0.28.1`
**Mode**: Standalone (single instance)
**Storage**: File backend with persistent volume

**Configuration** ([vault.yaml:14-49](kubernetes/argocd/apps/vault.yaml#L14-L49)):
```yaml
server:
  standalone:
    enabled: true
    config: |
      ui = true

      listener "tcp" {
        tls_disable = 1
        address = "[::]:8200"
        cluster_address = "[::]:8201"
      }

      storage "file" {
        path = "/vault/data"
      }

  dataStorage:
    enabled: true
    size: 10Gi
    storageClass: local-path
```

### Vault Initialization

**Critical Steps**:

1. **Initialize Vault** (one-time operation):
```bash
kubectl exec -n vault vault-0 -- vault operator init -key-shares=1 -key-threshold=1
```

**Save Output**:
- Unseal Key: `<KEY_VALUE>`
- Root Token: `<TOKEN_VALUE>`

2. **Unseal Vault** (required after every pod restart):
```bash
kubectl exec -n vault vault-0 -- vault operator unseal <UNSEAL_KEY>
```

3. **Login and Configure**:
```bash
kubectl exec -n vault vault-0 -- vault login <ROOT_TOKEN>

# Enable KV v2 secrets engine
kubectl exec -n vault vault-0 -- vault secrets enable -path=secret kv-v2

# Create PostgreSQL secrets
kubectl exec -n vault vault-0 -- vault kv put secret/postgres/shlink \
  password="<DB_PASSWORD>" \
  user="shlink" \
  dbname="shlink" \
  host="shlink-db-primary.postgres.svc.cluster.local" \
  port="5432"
```

### Kubernetes Authentication

**Enable Kubernetes Auth**:
```bash
kubectl exec -n vault vault-0 -- vault auth enable kubernetes
```

**Configure with Service Account Token**:
```bash
kubectl exec -n vault vault-0 -- sh -c "vault write auth/kubernetes/config \
    token_reviewer_jwt=\"\$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)\" \
    kubernetes_host=\"https://kubernetes.default.svc:443\" \
    kubernetes_ca_cert=\"\$(cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt)\""
```

**Create Policy**:
```bash
kubectl exec -n vault vault-0 -- vault policy write external-secrets - <<EOF
path "secret/data/postgres/*" {
  capabilities = ["read"]
}
path "secret/data/redis/*" {
  capabilities = ["read"]
}
EOF
```

**Create Role**:
```bash
kubectl exec -n vault vault-0 -- vault write auth/kubernetes/role/external-secrets \
    bound_service_account_names=external-secrets-sa \
    bound_service_account_namespaces=shlink \
    policies=external-secrets \
    ttl=24h
```

### External Secrets Operator Configuration

**SecretStore** ([secret-store.yaml](kubernetes/kustomize/shlink/secret-store.yaml)):
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets-sa
  namespace: shlink
---
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: shlink
spec:
  provider:
    vault:
      server: "http://vault.vault.svc.cluster.local:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets"
          serviceAccountRef:
            name: "external-secrets-sa"
```

**ExternalSecret** ([external-secret.yaml](kubernetes/kustomize/shlink/external-secret.yaml)):
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: postgres-credentials
  namespace: shlink
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: shlink-db-pguser-shlink
    creationPolicy: Owner
  data:
  - secretKey: password
    remoteRef:
      key: postgres/shlink
      property: password
  - secretKey: user
    remoteRef:
      key: postgres/shlink
      property: user
  - secretKey: dbname
    remoteRef:
      key: postgres/shlink
      property: dbname
  - secretKey: host
    remoteRef:
      key: postgres/shlink
      property: host
  - secretKey: port
    remoteRef:
      key: postgres/shlink
      property: port
```

### Vault Gotchas

**1. Token Reviewer JWT Not Set**
```bash
# Check if configured
kubectl exec -n vault vault-0 -- vault read auth/kubernetes/config

# If token_reviewer_jwt_set: false, reconfigure
kubectl exec -n vault vault-0 -- sh -c "vault write auth/kubernetes/config \
    token_reviewer_jwt=\"\$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)\" \
    kubernetes_host=\"https://kubernetes.default.svc:443\" \
    kubernetes_ca_cert=\"\$(cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt)\""
```

**2. Service Account Not Authorized**
```
Error: service account name not authorized
```

**Fix**: Ensure service account is in the role's `bound_service_account_names`:
```bash
kubectl exec -n vault vault-0 -- vault read auth/kubernetes/role/external-secrets
```

**3. Vault Sealed After Restart**

Vault doesn't auto-unseal in standalone mode. After pod restart:
```bash
kubectl exec -n vault vault-0 -- vault operator unseal <UNSEAL_KEY>
```

**Production Solution**: Use auto-unseal with cloud KMS (AWS KMS, GCP KMS, Azure Key Vault).

**4. Permission Denied Errors**

Check External Secrets Operator logs:
```bash
kubectl logs -n external-secrets deployment/external-secrets
```

Common issues:
- Missing RBAC for token review
- Incorrect Vault policy
- Wrong namespace in role binding

---

## Deployment Configuration

### Full Shlink Deployment

**File**: [kubernetes/kustomize/shlink/deployment.yaml](kubernetes/kustomize/shlink/deployment.yaml)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shlink
  labels:
    app: shlink
spec:
  replicas: 3
  selector:
    matchLabels:
      app: shlink
  template:
    metadata:
      labels:
        app: shlink
        version: stable
    spec:
      containers:
      - name: shlink
        image: shlinkio/shlink:stable
        ports:
        - containerPort: 8080
          name: http
          protocol: TCP
        env:
        - name: SHELL_VERBOSITY
          value: "3"  # Increased logging for troubleshooting
        - name: DEFAULT_DOMAIN
          value: "shlink.local"
        - name: IS_HTTPS_ENABLED
          value: "false"

        # PostgreSQL Configuration
        - name: DB_DRIVER
          value: "postgres"
        - name: DB_HOST
          value: "shlink-db-primary.postgres.svc.cluster.local"
        - name: DB_PORT
          value: "5432"
        - name: DB_NAME
          value: "shlink"
        - name: DB_USER
          value: "shlink"
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: shlink-db-pguser-shlink
              key: password

        # Redis Configuration (commented out)
        # - name: REDIS_SERVERS
        #   value: "rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local:6379"

        - name: GEOLITE_LICENSE_KEY
          value: ""

        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"

        livenessProbe:
          httpGet:
            path: /rest/health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10

        readinessProbe:
          httpGet:
            path: /rest/health
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
```

### Environment Variables Reference

| Variable | Value | Purpose |
|----------|-------|---------|
| `SHELL_VERBOSITY` | `3` | Enable verbose logging |
| `DEFAULT_DOMAIN` | `shlink.local` | Default domain for short URLs |
| `IS_HTTPS_ENABLED` | `false` | Disable HTTPS (handled by ingress) |
| `DB_DRIVER` | `postgres` | Use PostgreSQL driver |
| `DB_HOST` | `shlink-db-primary.postgres.svc.cluster.local` | PostgreSQL service DNS |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `shlink` | Database name |
| `DB_USER` | `shlink` | Database user |
| `DB_PASSWORD` | `<from-secret>` | Database password from Vault |
| `REDIS_SERVERS` | (disabled) | Redis connection string |
| `REDIS_SENTINEL_SERVICE` | (not used) | Sentinel master name |
| `GEOLITE_LICENSE_KEY` | `""` | GeoIP license (optional) |

---

## Istio Service Mesh Integration

**Date Added**: 2025-12-30
**Istio Version**: 1.24.2

### Overview

Istio service mesh was deployed to provide:
- **Traffic management**: Ingress gateway for external access
- **Observability**: Request tracing and metrics collection
- **Security**: mTLS for pod-to-pod communication
- **Resilience**: Circuit breaking, retries, and timeout policies

### Architecture

```
                    External Traffic
                           │
                           ▼
                  ┌─────────────────┐
                  │ Istio Ingress   │
                  │    Gateway      │
                  │ (LoadBalancer)  │
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │     Gateway     │
                  │   (port 80)     │
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │ VirtualService  │
                  │  (routing)      │
                  └────────┬────────┘
                           │
                           ▼
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌────────┐         ┌────────┐         ┌────────┐
   │Shlink-1│         │Shlink-2│         │Shlink-3│
   │┌──────┐│         │┌──────┐│         │┌──────┐│
   ││ App  ││         ││ App  ││         ││ App  ││
   │└──────┘│         │└──────┘│         │└──────┘│
   │┌──────┐│         │┌──────┐│         │┌──────┐│
   ││Envoy ││         ││Envoy ││         ││Envoy ││
   ││Proxy ││         ││Proxy ││         ││Proxy ││
   │└──────┘│         │└──────┘│         │└──────┘│
   └────────┘         └────────┘         └────────┘
```

### Installation Steps

#### 1. Install Istio

**Download Istio**:
```bash
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.24.2 sh -
cd istio-1.24.2
```

**Pre-installation Check**:
```bash
export KUBECONFIG=~/.kube/config-k3s
./bin/istioctl x precheck
```

**Install with Default Profile**:
```bash
./bin/istioctl install --set profile=default -y
```

**Verify Installation**:
```bash
kubectl get pods -n istio-system
kubectl get svc -n istio-system
```

Expected output:
```
NAME                                    READY   STATUS    RESTARTS   AGE
istio-ingressgateway-xxxxx              1/1     Running   0          2m
istiod-xxxxx                            1/1     Running   0          2m

NAME                   TYPE           EXTERNAL-IP       PORT(S)
istio-ingressgateway   LoadBalancer   192.168.2.242     15021:xxx/TCP,80:xxx/TCP,443:xxx/TCP
istiod                 ClusterIP      10.43.55.241      15010/TCP,15012/TCP,443/TCP,15014/TCP
```

#### 2. Enable Sidecar Injection

**Label the Namespace**:
```bash
kubectl label namespace shlink istio-injection=enabled --overwrite
```

**Restart Shlink Deployment**:
```bash
kubectl rollout restart deployment/shlink -n shlink
```

**Verify Sidecars Injected**:
```bash
kubectl get pods -n shlink
```

Expected: Each pod should show `2/2` containers (app + Envoy sidecar)
```
NAME                      READY   STATUS    RESTARTS   AGE
shlink-xxxxx              2/2     Running   0          1m
shlink-xxxxx              2/2     Running   0          1m
shlink-xxxxx              2/2     Running   0          1m
```

#### 3. Create Gateway Configuration

**File**: `kubernetes/kustomize/shlink/istio/gateway.yaml`

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: shlink-gateway
  namespace: shlink
spec:
  selector:
    istio: ingressgateway
  servers:
  - port:
      number: 80
      name: http
      protocol: HTTP
    hosts:
    - "*"
```

**Key Points**:
- `selector: istio: ingressgateway` - Uses the default Istio ingress gateway
- `hosts: "*"` - Accepts all hostnames (for testing; use specific domain in production)
- Port 80 for HTTP traffic

#### 4. Create VirtualService Configuration

**File**: `kubernetes/kustomize/shlink/istio/virtualservice.yaml`

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: shlink-virtualservice
  namespace: shlink
spec:
  hosts:
  - "*"
  gateways:
  - shlink-gateway
  http:
  - match:
    - uri:
        prefix: /
    route:
    - destination:
        host: shlink.shlink.svc.cluster.local
        port:
          number: 8080
```

**Key Points**:
- `gateways: shlink-gateway` - Binds to the Gateway resource
- `destination: shlink.shlink.svc.cluster.local` - Routes to Shlink Kubernetes service
- Port 8080 matches Shlink's container port

#### 5. Update Kustomization

**File**: `kubernetes/kustomize/shlink/kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shlink

resources:
- deployment.yaml
- service.yaml
- secret-store.yaml
- external-secret.yaml
- istio/gateway.yaml           # Added
- istio/virtualservice.yaml    # Added
```

#### 6. Deploy via kubectl

```bash
kubectl apply -f kubernetes/kustomize/shlink/istio/gateway.yaml
kubectl apply -f kubernetes/kustomize/shlink/istio/virtualservice.yaml
```

**Note**: For full GitOps, these should be managed by ArgoCD. The manual apply is for initial setup.

#### 7. Verify Istio Resources

```bash
kubectl get gateway,virtualservice -n shlink
```

Expected output:
```
NAME                                         AGE
gateway.networking.istio.io/shlink-gateway   1m

NAME                                                       GATEWAYS             HOSTS   AGE
virtualservice.networking.istio.io/shlink-virtualservice   ["shlink-gateway"]   ["*"]   1m
```

### Testing Shlink via Istio

#### Get Ingress Gateway IP

```bash
export INGRESS_IP=$(kubectl get svc -n istio-system istio-ingressgateway \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo $INGRESS_IP
# Output: 192.168.2.242
```

#### Test Health Endpoint

```bash
curl http://$INGRESS_IP/rest/health | jq .
```

Expected response:
```json
{
  "status": "pass",
  "version": "4.6.0",
  "links": {
    "about": "https://shlink.io",
    "project": "https://github.com/shlinkio/shlink"
  }
}
```

#### Generate API Key

```bash
kubectl exec -n shlink deployment/shlink -- bin/cli api-key:generate
```

Save the generated API key (e.g., `909581e3-e271-4ea7-ad1a-734f2f834ae6`)

#### Create Short URL

```bash
export API_KEY="909581e3-e271-4ea7-ad1a-734f2f834ae6"

curl -X POST http://$INGRESS_IP/rest/v3/short-urls \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "longUrl": "https://github.com/shlinkio/shlink",
    "customSlug": "gh-shlink"
  }' | jq .
```

Expected response:
```json
{
  "shortUrl": "http://shlink.local/gh-shlink",
  "shortCode": "gh-shlink",
  "longUrl": "https://github.com/shlinkio/shlink",
  "dateCreated": "2025-12-30T03:00:09+00:00",
  "visitsSummary": {
    "total": 0,
    "nonBots": 0,
    "bots": 0
  }
}
```

#### Test URL Redirection

```bash
curl -I http://$INGRESS_IP/gh-shlink
```

Expected response:
```
HTTP/1.1 302 Found
location: https://github.com/shlinkio/shlink
x-envoy-upstream-service-time: 58
server: istio-envoy
```

#### Check Visit Statistics

```bash
curl http://$INGRESS_IP/rest/v3/short-urls/gh-shlink/visits \
  -H "X-Api-Key: $API_KEY" | jq '.visits.pagination.totalItems'
```

### Traffic Management Features

#### Add Retry Policy

Update VirtualService to add automatic retries:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: shlink-virtualservice
  namespace: shlink
spec:
  hosts:
  - "*"
  gateways:
  - shlink-gateway
  http:
  - match:
    - uri:
        prefix: /
    route:
    - destination:
        host: shlink.shlink.svc.cluster.local
        port:
          number: 8080
    retries:
      attempts: 3
      perTryTimeout: 2s
      retryOn: 5xx,reset,connect-failure,refused-stream
```

#### Add Request Timeout

```yaml
    timeout: 10s
```

#### Add Circuit Breaker

Create a DestinationRule:

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: shlink-circuit-breaker
  namespace: shlink
spec:
  host: shlink.shlink.svc.cluster.local
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
        maxRequestsPerConnection: 2
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
```

### Security Configuration

#### Enable mTLS

Create PeerAuthentication for mutual TLS:

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: shlink-mtls
  namespace: shlink
spec:
  mtls:
    mode: STRICT
```

This enforces encrypted communication between Shlink pods.

#### Add Authorization Policy

Restrict access to specific paths:

```yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: shlink-authz
  namespace: shlink
spec:
  selector:
    matchLabels:
      app: shlink
  rules:
  - to:
    - operation:
        paths: ["/rest/*"]
    when:
    - key: request.headers[x-api-key]
      values: ["*"]  # Requires API key header
```

### Observability

#### View Istio Metrics

```bash
kubectl exec -n shlink deployment/shlink -c istio-proxy -- \
  curl -s localhost:15000/stats/prometheus | grep istio
```

#### Check Envoy Configuration

```bash
./istio-1.24.2/bin/istioctl proxy-config routes deployment/shlink.shlink
```

#### Analyze Traffic

```bash
./istio-1.24.2/bin/istioctl analyze -n shlink
```

### Troubleshooting

#### Pods Not Getting Sidecars

**Check namespace label**:
```bash
kubectl get namespace shlink --show-labels | grep istio-injection
```

**Re-label if needed**:
```bash
kubectl label namespace shlink istio-injection=enabled --overwrite
kubectl rollout restart deployment/shlink -n shlink
```

#### Gateway Not Routing Traffic

**Check Gateway status**:
```bash
kubectl describe gateway shlink-gateway -n shlink
```

**Check VirtualService binding**:
```bash
kubectl describe virtualservice shlink-virtualservice -n shlink
```

**Verify ingress gateway selector**:
```bash
kubectl get deployment -n istio-system istio-ingressgateway \
  -o jsonpath='{.spec.template.metadata.labels.istio}'
```

Should output: `ingressgateway`

#### 503 Service Unavailable

**Check if backend service exists**:
```bash
kubectl get svc -n shlink shlink
```

**Verify endpoints**:
```bash
kubectl get endpoints -n shlink shlink
```

**Check pod readiness**:
```bash
kubectl get pods -n shlink -o wide
```

All pods should be `2/2 Running` with `READY` status.

#### View Envoy Logs

```bash
kubectl logs -n shlink deployment/shlink -c istio-proxy --tail=50
```

### Production Considerations

**1. TLS/HTTPS Configuration**

Update Gateway for HTTPS:
```yaml
spec:
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    tls:
      mode: SIMPLE
      credentialName: shlink-tls-cert  # Kubernetes secret with cert
    hosts:
    - "shlink.example.com"
```

**2. Custom Domain**

Update VirtualService hosts:
```yaml
spec:
  hosts:
  - "shlink.example.com"
```

**3. Rate Limiting**

Consider adding Envoy rate limiting filter for API protection.

**4. Monitoring Integration**

Deploy Istio observability stack:
- **Kiali**: Service mesh visualization
- **Jaeger**: Distributed tracing
- **Prometheus**: Metrics collection
- **Grafana**: Dashboards

```bash
kubectl apply -f istio-1.24.2/samples/addons/
```

**5. Resource Limits**

Each Envoy sidecar adds overhead (~50-100MB memory, 0.1 CPU). Adjust pod resource limits accordingly.

### Key Learnings

1. **Sidecar Injection**: Requires namespace labeling and pod restart
2. **Gateway Selector**: Must match `istio: ingressgateway` label on ingress gateway pods
3. **FQDN in Destination**: Use fully qualified service name (e.g., `shlink.shlink.svc.cluster.local`)
4. **Port Matching**: VirtualService destination port must match Service targetPort
5. **LoadBalancer IPs**: K3s provides multiple IPs for LoadBalancer services; use the first one
6. **Envoy Logs**: Check `istio-proxy` container logs for routing issues
7. **Health Checks**: Existing Kubernetes health probes work with Istio (no changes needed)

### Current Status

- Istio 1.24.2 installed and running
- Ingress gateway accessible at `192.168.2.242`
- All 3 Shlink pods running with Envoy sidecars (2/2 containers)
- Gateway and VirtualService configured and routing traffic
- Full Shlink functionality verified (health, API, redirects, analytics)
- mTLS not yet enabled (planned for production)
- Observability stack not deployed (Kiali, Jaeger, Grafana)

---

## Troubleshooting Guide

### Common Issues and Solutions

#### 1. Shlink Pods CrashLoopBackOff

**Check logs**:
```bash
kubectl logs -n shlink deployment/shlink --tail=100
```

**Common causes**:
- Database connection failure → Check PostgreSQL service DNS
- Schema permission denied → Grant `GRANT ALL ON SCHEMA public TO shlink`
- Redis connection errors → Disable Redis temporarily
- Secret not found → Check ExternalSecret sync status

#### 2. Database Migration Failures

**Error**: `permission denied for schema public`

**Solution**:
```bash
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -d shlink -c "GRANT ALL ON SCHEMA public TO shlink;"
```

**Error**: `could not connect to server`

**Check PostgreSQL**:
```bash
kubectl get pods -n postgres
kubectl logs -n postgres shlink-db-primary-0 -c database
```

#### 3. External Secrets Not Syncing

**Check status**:
```bash
kubectl describe externalsecret -n shlink postgres-credentials
```

**Look for**:
- `SecretSynced: True` → Working
- `SecretSyncedError` → Check error message

**Debug steps**:
1. Verify Vault is unsealed:
   ```bash
   kubectl exec -n vault vault-0 -- vault status
   ```

2. Check SecretStore:
   ```bash
   kubectl describe secretstore -n shlink vault-backend
   ```

3. Test Vault connectivity from pod:
   ```bash
   kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
     curl http://vault.vault.svc.cluster.local:8200/v1/sys/health
   ```

4. Check External Secrets Operator logs:
   ```bash
   kubectl logs -n external-secrets deployment/external-secrets -f
   ```

#### 4. Redis DNS Resolution

**Test DNS**:
```bash
kubectl run -it --rm debug --image=busybox --restart=Never -n shlink -- \
  nslookup rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local
```

**Expected**:
```
Name:   rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local
Address: 10.42.x.x
```

**If NXDOMAIN**:
- Check headless service exists: `kubectl get svc -n redis rfr-shlink-redis`
- Verify service selector matches pods: `kubectl get pods -n redis --show-labels`
- Check EndpointSlice: `kubectl get endpointslice -n redis`

#### 5. ArgoCD Auto-Pruning Resources

**Issue**: Manually created resources get deleted by ArgoCD.

**Solution**: Add resources to Git and sync through ArgoCD:
```bash
argocd app sync redis-cluster --grpc-web
argocd app sync shlink --grpc-web
```

**Check sync status**:
```bash
argocd app get redis-cluster --grpc-web
argocd app get shlink --grpc-web
```

#### 6. Health Check Failures

**Test health endpoint**:
```bash
kubectl exec -n shlink deployment/shlink -- \
  curl -s http://localhost:8080/rest/health
```

**Expected response**:
```json
{
  "status": "pass",
  "version": "4.6.0",
  "links": {
    "about": "https://shlink.io",
    "project": "https://github.com/shlinkio/shlink"
  }
}
```

**Debug startup**:
```bash
# Watch pod startup in real-time
kubectl logs -n shlink deployment/shlink -f

# Check if RoadRunner started
kubectl logs -n shlink deployment/shlink | grep "RoadRunner server started"
```

---

## Lessons Learned

### 1. PostgreSQL Permissions Are Not Automatic

**Lesson**: The Crunchy Data Operator creates users but doesn't grant full schema permissions.

**Impact**: Database migrations fail with cryptic permission errors.

**Solution**: Always include a post-provisioning step to grant schema permissions.

**Future Improvement**: Create a Kubernetes Job that runs after PostgreSQL is ready:
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: grant-shlink-permissions
spec:
  template:
    spec:
      containers:
      - name: grant-permissions
        image: postgres:16
        command:
        - psql
        - -h
        - shlink-db-primary.postgres.svc.cluster.local
        - -U
        - postgres
        - -d
        - shlink
        - -c
        - "GRANT ALL ON SCHEMA public TO shlink;"
```

### 2. Redis Cluster Mode ≠ Redis Sentinel Mode

**Lesson**: Different Redis deployment architectures require different client configurations.

**Key Differences**:
- **Cluster Mode**: Data sharding, `CLUSTER SLOTS` command, `cluster_enabled:1`
- **Sentinel Mode**: Master-replica failover, no sharding, `cluster_enabled:0`
- **Standalone**: Single instance, no HA

**Impact**: Shlink's Predis library assumes cluster mode when given multiple servers, causing incompatibility with Sentinel.

**Solution**: Match your deployment mode to your client library's expectations.

### 3. StatefulSet Pods Need Headless Services for DNS

**Lesson**: StatefulSet pods don't get individual DNS records without a headless service.

**Why**: Kubernetes only creates `<pod-name>.<headless-service>.<namespace>.svc.cluster.local` DNS records when a headless service (`clusterIP: None`) exists.

**Impact**: Applications can't reach individual StatefulSet pods by name.

**Solution**: Always create a headless service for StatefulSets when individual pod addressing is needed.

### 4. External Secrets Operator Requires Proper RBAC

**Lesson**: ESO needs permission to perform token review for Vault authentication.

**Required**:
- ServiceAccount in target namespace
- Vault role bound to that ServiceAccount
- Token reviewer permissions in Kubernetes
- Proper Vault policy for secret paths

**Debug Strategy**: Work backwards from the error:
1. Check External Secrets logs
2. Verify SecretStore configuration
3. Test Vault authentication manually
4. Validate Vault policy

### 5. Vault Auto-Unseal Is Essential for Production

**Lesson**: Manual unsealing after every pod restart is operationally painful.

**Impact**: Vault restarts (rolling updates, node failures) require manual intervention.

**Production Solution**: Configure auto-unseal with cloud KMS:
```hcl
seal "awskms" {
  region     = "us-west-2"
  kms_key_id = "alias/vault-unseal-key"
}
```

### 6. Start Simple, Add Complexity Incrementally

**Lesson**: Trying to integrate PostgreSQL + Redis + Vault simultaneously made troubleshooting difficult.

**Better Approach**:
1. Deploy Shlink with PostgreSQL only
2. Verify health and basic functionality
3. Add Vault for secrets management
4. Integrate Redis after application is stable

**Benefit**: Isolate variables, faster debugging, clear baseline.

### 7. Read Application Startup Logs Carefully

**Lesson**: Shlink's startup sequence provided clear indicators of what was failing:
- `db:create` → Database creation
- `db:migrate` → Schema migrations
- `orm:generate-proxies` → Doctrine ORM setup
- `orm:clear-cache:metadata` → Cache initialization
- `RoadRunner server started` → Web server ready

**Impact**: Each step's success/failure pinpointed the exact integration issue.

**Strategy**: Monitor startup logs during initial deployment to catch configuration errors early.

### 8. Health Checks Should Match Application Readiness

**Lesson**: Shlink provides `/rest/health` endpoint that accurately reflects readiness.

**Configuration**:
```yaml
livenessProbe:
  httpGet:
    path: /rest/health
    port: 8080
  initialDelaySeconds: 30  # Allow time for migrations
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /rest/health
    port: 8080
  initialDelaySeconds: 10  # Faster readiness detection
  periodSeconds: 5
```

**Impact**: Kubernetes only routes traffic to pods that have successfully completed migrations and are truly ready.

---

## Next Steps

### Immediate Actions

1. **Document Manual Steps**
   - Create runbook for PostgreSQL permission grants
   - Document Vault unseal process
   - Add troubleshooting playbook to ops documentation

2. **Monitoring and Observability**
   - Add Prometheus metrics for Shlink
   - Set up Grafana dashboards for database connections
   - Configure alerts for pod restarts and health check failures

3. **Test Application Functionality**
   - Create a short URL via API
   - Test URL redirection
   - Verify analytics tracking

### Future Improvements

1. **Redis Integration**
   - Evaluate switching to Redis Cluster mode
   - Consider alternative: Use single Redis master with Sentinel failover handling
   - Test with phpredis extension instead of Predis

2. **Secrets Automation**
   - Implement Vault auto-unseal with cloud KMS
   - Automate Vault initialization and configuration
   - Set up secret rotation policies

3. **Database Management**
   - Automate schema permission grants via Kubernetes Job
   - Set up automated backups for PostgreSQL
   - Configure backup retention and recovery testing

4. **High Availability**
   - Test PostgreSQL failover scenarios
   - Verify Vault HA setup (requires Consul/Raft storage)
   - Implement Redis HA when integrated

5. **Security Hardening**
   - Enable TLS for Vault
   - Implement network policies for pod-to-pod communication
   - Set up Pod Security Standards

---

## References

- [Shlink Documentation](https://shlink.io/documentation/)
- [Shlink Docker Environment Variables](https://shlink.io/documentation/install-docker-image/#supported-env-vars)
- [Crunchy Data PostgreSQL Operator](https://access.crunchydata.com/documentation/postgres-operator/latest/)
- [Spotahome Redis Operator](https://github.com/spotahome/redis-operator)
- [External Secrets Operator - Vault Provider](https://external-secrets.io/latest/provider/hashicorp-vault/)
- [HashiCorp Vault Kubernetes Auth](https://developer.hashicorp.com/vault/docs/auth/kubernetes)
- [Predis Redis Client](https://github.com/predis/predis)

---

**Document Version**: 1.0
**Last Updated**: 2025-12-29
**Maintainer**: Manu B Sreekumari
