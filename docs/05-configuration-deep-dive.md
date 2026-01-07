# Configuration Deep Dive - URL Shortener SRE Lab

**Purpose**: Complete end-to-end explanation of every configuration file and architectural decision in this project. This guide helps you understand not just what was deployed, but WHY and HOW each component is configured.

**Last Updated**: December 30, 2024

---

## Table of Contents

1. [Infrastructure Foundation](#1-infrastructure-foundation)
2. [GitOps Platform - ArgoCD](#2-gitops-platform---argocd)
3. [Data Layer](#3-data-layer)
4. [Application Deployment](#4-application-deployment)
5. [Service Mesh - Istio](#5-service-mesh---istio)
6. [Observability Stack](#6-observability-stack)
7. [Load Testing](#7-load-testing)
8. [Configuration Patterns](#8-configuration-patterns)

---

## 1. Infrastructure Foundation

### 1.1 K3s Cluster Setup

**What is K3s?**
K3s is a lightweight Kubernetes distribution designed for resource-constrained environments. It packages everything (control plane, kubelet, container runtime) into a single binary under 100MB.

**Your Cluster Architecture:**
```
Single Physical Host: Minisforum UM790 Pro
├── Proxmox VE (Hypervisor)
│   ├── VM 1: 192.168.2.242 (K3s server + worker)
│   ├── VM 2: 192.168.2.243 (K3s server + worker)
│   └── VM 3: 192.168.2.244 (K3s server + worker)
```

**Why 3 Nodes?**
- **Etcd Quorum**: Embedded etcd needs odd numbers (3, 5, 7) for consensus
- **High Availability**: Control plane survives 1 node failure
- **Pod Distribution**: Workloads spread across nodes for resilience

**K3s Installation Command (First Node):**
```bash
curl -sfL https://get.k3s.io | sh -s - server \
  --cluster-init \
  --disable traefik \
  --write-kubeconfig-mode 644 \
  --node-ip 192.168.2.242 \
  --node-external-ip 192.168.2.242
```

**Why Each Flag:**
- `--cluster-init`: Initialize embedded etcd cluster (HA mode)
- `--disable traefik`: We're using Istio for ingress instead
- `--write-kubeconfig-mode 644`: Make kubeconfig readable by non-root
- `--node-ip`: Internal cluster IP
- `--node-external-ip`: IP for external LoadBalancer services

**Additional Nodes (2 & 3):**
```bash
curl -sfL https://get.k3s.io | sh -s - server \
  --server https://192.168.2.242:6443 \
  --token <TOKEN_FROM_NODE1> \
  --node-ip 192.168.2.243 \
  --node-external-ip 192.168.2.243
```

**Key Components K3s Includes:**
- **Flannel**: CNI (Container Network Interface) for pod networking
- **CoreDNS**: DNS resolution for service discovery
- **Metrics Server**: Pod/node metrics for `kubectl top`
- **Local Path Provisioner**: Default StorageClass for PersistentVolumes
- **ServiceLB (klipper-lb)**: LoadBalancer implementation using node IPs

### 1.2 Storage - Local Path Provisioner

**Configuration**: Built into K3s, no additional setup needed

**How It Works:**
1. When a PVC (PersistentVolumeClaim) is created, a PV is dynamically provisioned
2. Data stored in `/var/lib/rancher/k3s/storage/` on the node
3. Volume bound to the node where pod runs (non-portable)

**Example PVC:**
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
spec:
  accessModes:
    - ReadWriteOnce  # Single node access only
  resources:
    requests:
      storage: 20Gi
  storageClassName: local-path
```

**Limitations:**
- **Not portable**: If pod moves to another node, data doesn't follow
- **Node failure risk**: Data lost if node dies (mitigated by StatefulSet affinity)

**Why Acceptable Here:**
- PostgreSQL operator manages replication across nodes
- Each StatefulSet pod gets its own PVC on its node
- Database-level replication provides data redundancy

### 1.3 Networking - Flannel CNI

**What Flannel Does:**
- Assigns pod IP addresses from cluster CIDR (10.42.0.0/16 by default)
- Creates overlay network using VXLAN for pod-to-pod communication
- Each node gets a subnet (/24) from the cluster CIDR

**Pod IP Allocation Example:**
```
Node 1 (192.168.2.242): Pods get 10.42.0.x
Node 2 (192.168.2.243): Pods get 10.42.1.x
Node 3 (192.168.2.244): Pods get 10.42.2.x
```

**Service CIDR:** 10.43.0.0/16 (ClusterIP services)

**Traffic Flow:**
```
Pod A (10.42.0.5) on Node 1
    ↓
VXLAN tunnel
    ↓
Pod B (10.42.1.8) on Node 2
```

### 1.4 Load Balancing - ServiceLB (klipper-lb)

**What It Does:**
K3s ServiceLB provides LoadBalancer service type without cloud provider. It uses DaemonSet pods to forward traffic to service endpoints.

**How It Works:**
1. Create Service with `type: LoadBalancer`
2. ServiceLB controller assigns one of the node IPs as EXTERNAL-IP
3. DaemonSet pod on that node listens on the service port
4. Traffic forwarded to service endpoints (pods)

**Example Service:**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: istio-ingressgateway
  namespace: istio-system
spec:
  type: LoadBalancer
  ports:
    - port: 80
      targetPort: 8080
      name: http
  selector:
    app: istio-ingressgateway
```

**Result:**
```bash
$ kubectl get svc -n istio-system istio-ingressgateway
NAME                   TYPE           EXTERNAL-IP      PORT(S)
istio-ingressgateway   LoadBalancer   192.168.2.242    80:31234/TCP
```

**Port Conflict Issue:**
If multiple LoadBalancer services use the same port on the same node IP, only one can bind. This is why Grafana uses port 3000 instead of 80.

---

## 2. GitOps Platform - ArgoCD

### 2.1 ArgoCD Architecture

**What is GitOps?**
GitOps uses Git as the single source of truth for declarative infrastructure. Changes committed to Git are automatically applied to the cluster.

**ArgoCD Components:**
```
ArgoCD Namespace (argocd)
├── argocd-server (API/UI)
├── argocd-repo-server (Git operations)
├── argocd-application-controller (Sync loop)
├── argocd-redis (Cache)
└── argocd-dex-server (SSO - disabled in our setup)
```

### 2.2 Installation

**File:** Installed via official manifests (not in Git repo)

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

**Why Not in Git?**
ArgoCD needs to be running before it can manage itself. Bootstrap manually, then ArgoCD can manage its own updates.

### 2.3 App-of-Apps Pattern

**Concept:**
One "root" ArgoCD Application that deploys all other Applications. This creates a hierarchy.

**Your Structure:**
```
root-app (App-of-Apps)
├── infrastructure/
│   ├── cert-manager
│   └── vault
├── operators/
│   ├── postgres-operator
│   ├── redis-operator
│   ├── external-secrets
│   └── kiali-operator
├── data-layer/
│   ├── postgres-cluster
│   ├── redis-cluster
│   └── redis-secret
├── application/
│   └── shlink
└── observability/
    ├── prometheus-stack
    ├── jaeger
    ├── istio-telemetry
    └── istio-monitoring
```

**Root App Configuration:**
```yaml
# kubernetes/argocd/root-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root-app
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/manubalasree/url-shortener-sre-lab
    targetRevision: main
    path: kubernetes/argocd/apps
    directory:
      recurse: true  # Scan all subdirectories
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true     # Delete resources removed from Git
      selfHeal: true  # Revert manual changes
    syncOptions:
      - CreateNamespace=true
```

**Key Fields Explained:**

**source.repoURL**: Your Git repository
**source.path**: Directory containing Application manifests
**directory.recurse**: Scan subdirectories for Applications
**syncPolicy.automated.prune**: Remove resources deleted from Git
**syncPolicy.automated.selfHeal**: Undo manual `kubectl` changes
**syncOptions.CreateNamespace**: Auto-create target namespaces

### 2.4 Application Template Pattern

**Template File:** `kubernetes/argocd/apps/_template.yaml`

Every Application follows this structure:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: <app-name>
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io  # Cleanup on delete
spec:
  project: default
  source:
    repoURL: https://github.com/manubalasree/url-shortener-sre-lab
    targetRevision: main
    path: kubernetes/kustomize/<component>
  destination:
    server: https://kubernetes.default.svc
    namespace: <target-namespace>
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

**Finalizer Explained:**
`resources-finalizer.argocd.argoproj.io` ensures when you delete an Application, ArgoCD deletes all deployed resources first (cascading delete).

**Retry Policy:**
If sync fails, ArgoCD retries with exponential backoff:
- Attempt 1: Wait 5s
- Attempt 2: Wait 10s (5s × 2)
- Attempt 3: Wait 20s
- Attempt 4: Wait 40s
- Attempt 5: Wait 80s (capped at 3m)

### 2.5 Example: Shlink Application

**File:** `kubernetes/argocd/apps/application/shlink.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shlink
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/manubalasree/url-shortener-sre-lab
    targetRevision: main
    path: kubernetes/kustomize/shlink
  destination:
    server: https://kubernetes.default.svc
    namespace: shlink
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

**What Happens:**
1. ArgoCD clones the repo
2. Reads `kubernetes/kustomize/shlink/kustomization.yaml`
3. Builds manifests using Kustomize
4. Applies to `shlink` namespace
5. Watches Git repo every 3 minutes for changes
6. Auto-syncs when changes detected

---

## 3. Data Layer

### 3.1 PostgreSQL - Crunchy Data Operator

**Why Use an Operator?**
Operators extend Kubernetes with custom resources (CRDs) and controllers that automate complex stateful application management.

**Crunchy Operator Provides:**
- Automated PostgreSQL cluster creation
- High availability with streaming replication
- Automated backups (pgBackRest)
- Rolling updates with zero downtime
- Connection pooling (PgBouncer)

#### 3.1.1 Operator Installation

**File:** `kubernetes/argocd/apps/operators/postgres-operator.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: postgres-operator
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/CrunchyData/postgres-operator-examples
    targetRevision: v6.0.0
    path: kustomize/install/default
  destination:
    namespace: postgres-operator
```

**What Gets Installed:**
- CRDs: `PostgresCluster`, `PGUpgrade`, `PGAdmin`
- Controller: Watches for PostgresCluster resources
- RBAC: ServiceAccounts, Roles, RoleBindings
- Webhooks: Validation and mutation for PostgresCluster

#### 3.1.2 PostgreSQL Cluster Creation

**File:** `kubernetes/kustomize/postgres/postgres-cluster.yaml`

```yaml
apiVersion: postgres-operator.crunchydata.com/v1beta1
kind: PostgresCluster
metadata:
  name: shlink-db
  namespace: postgres
spec:
  postgresVersion: 15
  instances:
    - name: primary
      replicas: 1  # One primary
      dataVolumeClaimSpec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 20Gi
        storageClassName: local-path
    - name: replica
      replicas: 2  # Two read replicas
      dataVolumeClaimSpec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 20Gi
        storageClassName: local-path
  backups:
    pgbackrest:
      repos:
        - name: repo1
          volume:
            volumeClaimSpec:
              accessModes:
                - ReadWriteOnce
              resources:
                requests:
                  storage: 20Gi
  users:
    - name: shlink
      databases:
        - shlink
      options: "CREATEDB"
```

**Field Breakdown:**

**postgresVersion: 15**: Use PostgreSQL 15 (important for permission behavior)

**instances**: StatefulSet configurations
- **primary.replicas: 1**: One primary (read-write) instance
- **replica.replicas: 2**: Two replicas (read-only)
- **dataVolumeClaimSpec**: PVC template for each pod

**backups.pgbackrest**: Automated backup configuration
- **repos[0].name: repo1**: Backup repository identifier
- **volume**: PVC for storing backups

**users[0].name: shlink**: Creates PostgreSQL user
- **databases: [shlink]**: Auto-creates database
- **options: "CREATEDB"**: Grants CREATEDB privilege

**What the Operator Creates:**
```
StatefulSet: shlink-db-primary (1 pod)
StatefulSet: shlink-db-replica (2 pods)
PVC: shlink-db-primary-0 (20Gi)
PVC: shlink-db-replica-0 (20Gi)
PVC: shlink-db-replica-1 (20Gi)
Service: shlink-db-primary (primary endpoint)
Service: shlink-db-replicas (replica endpoints)
Secret: shlink-db-pguser-shlink (connection details)
```

#### 3.1.3 Connection Details Secret

The operator creates this secret automatically:

```bash
$ kubectl get secret -n postgres shlink-db-pguser-shlink -o yaml
```

**Secret Contents:**
```yaml
data:
  host: c2hsaW5rLWRiLXByaW1hcnkucG9zdGdyZXMuc3ZjLmNsdXN0ZXIubG9jYWw=
  # Decoded: shlink-db-primary.postgres.svc.cluster.local

  port: NTQzMg==
  # Decoded: 5432

  dbname: c2hsaW5r
  # Decoded: shlink

  user: c2hsaW5r
  # Decoded: shlink

  password: <base64-encoded-password>
```

**DNS Resolution:**
```
Service: shlink-db-primary.postgres.svc.cluster.local:5432
│
├── Pod: shlink-db-primary-0 (10.42.0.15:5432)
```

#### 3.1.4 PostgreSQL 15+ Schema Permission Issue

**The Problem:**
PostgreSQL 15 changed default schema permissions. Previously, all users could create objects in the `public` schema. Now, only the schema owner can.

**Operator Behavior:**
1. Creates user `shlink`
2. Creates database `shlink` owned by `postgres`
3. Does NOT grant `shlink` permissions on `public` schema

**Error When Shlink Tries Migrations:**
```
SQLSTATE[42501]: Insufficient privilege: 7 ERROR: permission denied for schema public
```

**Manual Fix Required:**
```bash
kubectl exec -n postgres shlink-db-primary-0 -c database -- \
  psql -U postgres -d shlink -c "GRANT ALL ON SCHEMA public TO shlink;"
```

**Why This Command:**
- `kubectl exec`: Run command in container
- `-n postgres`: Namespace
- `shlink-db-primary-0`: Primary pod name
- `-c database`: Container name (pod has multiple containers)
- `psql -U postgres`: Connect as superuser
- `-d shlink`: Target database
- `GRANT ALL ON SCHEMA public TO shlink`: Grant full permissions

**Future Automation:**
Create Kubernetes Job in `kubernetes/kustomize/postgres/`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: grant-schema-permissions
spec:
  template:
    spec:
      containers:
        - name: grant-perms
          image: postgres:15
          command:
            - psql
            - -U
            - postgres
            - -d
            - shlink
            - -c
            - "GRANT ALL ON SCHEMA public TO shlink;"
          env:
            - name: PGHOST
              value: shlink-db-primary.postgres.svc.cluster.local
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: shlink-db-pguser-postgres
                  key: password
      restartPolicy: OnFailure
```

### 3.2 Redis - Spotahome Operator

**Redis Architectures:**
1. **Standalone**: Single instance (no HA)
2. **Sentinel**: Master-replica with automatic failover
3. **Cluster**: Distributed sharding (6+ nodes, `cluster_enabled:1`)

**Your Deployment:** Sentinel mode (HA without sharding)

#### 3.2.1 Operator Installation

**File:** `kubernetes/argocd/apps/operators/redis-operator.yaml`

Deploys from Helm chart or manifests.

#### 3.2.2 RedisFailover Resource

**File:** `kubernetes/kustomize/redis/redis-cluster.yaml`

```yaml
apiVersion: databases.spotahome.com/v1
kind: RedisFailover
metadata:
  name: shlink-redis
  namespace: redis
spec:
  sentinel:
    replicas: 3
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 400m
        memory: 512Mi
  redis:
    replicas: 3
    storage:
      persistentVolumeClaim:
        metadata:
          name: redis-data
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 8Gi
          storageClassName: local-path
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 400m
        memory: 512Mi
```

**Field Breakdown:**

**sentinel.replicas: 3**: Three Sentinel processes for quorum
**redis.replicas: 3**: One master, two replicas
**storage.persistentVolumeClaim**: PVC template for each Redis pod
**resources**: CPU/memory requests and limits

**What Gets Created:**
```
StatefulSet: rfr-shlink-redis (3 Redis pods)
StatefulSet: rfs-shlink-redis (3 Sentinel pods)
Service: rfs-shlink-redis (Sentinel service)
Service: rfr-shlink-redis (headless for StatefulSet DNS)
```

**Pod Naming:**
```
Redis pods:
  rfr-shlink-redis-0 (master - elected by Sentinel)
  rfr-shlink-redis-1 (replica)
  rfr-shlink-redis-2 (replica)

Sentinel pods:
  rfs-shlink-redis-0
  rfs-shlink-redis-1
  rfs-shlink-redis-2
```

#### 3.2.3 Headless Service for StatefulSet DNS

**File:** `kubernetes/kustomize/redis/redis-headless-svc.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: rfr-shlink-redis
  namespace: redis
spec:
  clusterIP: None  # Headless service
  selector:
    app.kubernetes.io/name: redis
    app.kubernetes.io/part-of: shlink-redis
  ports:
    - port: 6379
      name: redis
```

**Why Headless Service?**

StatefulSet pods need stable DNS names for individual pod addressing.

**Without Headless Service:**
- Service DNS: `rfr-shlink-redis.redis.svc.cluster.local` → Load balances across all pods
- Cannot address individual pods

**With Headless Service (`clusterIP: None`):**
- Service DNS: `rfr-shlink-redis.redis.svc.cluster.local` → Returns all pod IPs
- Pod DNS: `rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local` → Specific pod
- Pod DNS: `rfr-shlink-redis-1.rfr-shlink-redis.redis.svc.cluster.local` → Specific pod

**Usage Example:**
```bash
# Connect to specific pod
redis-cli -h rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local -p 6379
```

#### 3.2.4 Redis Integration Issue

**Current Status:** Redis deployed but NOT integrated with Shlink

**Root Cause:** Shlink uses Predis PHP library, which has limitations with Sentinel mode.

**Attempted Configurations:**

**Attempt 1: Multiple Servers (Cluster Mode)**
```yaml
env:
  - name: REDIS_SERVERS
    value: "rfr-shlink-redis-0.rfr-shlink-redis.redis.svc.cluster.local:6379,
            rfr-shlink-redis-1.rfr-shlink-redis.redis.svc.cluster.local:6379,
            rfr-shlink-redis-2.rfr-shlink-redis.redis.svc.cluster.local:6379"
```

**Error:** `No connections left in the pool for CLUSTER SLOTS`

**Why:** Predis sees multiple servers and assumes Redis Cluster mode. It tries to execute `CLUSTER SLOTS` command, which fails because this is Sentinel mode (`cluster_enabled:0`).

**Attempt 2: Sentinel Configuration**
```yaml
env:
  - name: REDIS_SENTINEL_SERVICE
    value: "mymaster"
  - name: REDIS_SERVERS
    value: "rfs-shlink-redis.redis.svc.cluster.local:26379"
```

**Error:** `Fatal error: Cannot use object of type Predis\Response\Error as array`

**Why:** Symfony Cache (used by Shlink) doesn't properly handle Sentinel error responses through Predis.

**Solutions:**
1. **Deploy Redis Cluster Mode** (requires 6+ nodes, `cluster_enabled:1`)
2. **Use Single Master** with operator-managed failover (lose manual Sentinel control)
3. **Replace Predis with phpredis** (requires custom Shlink Docker image)
4. **Use External Redis** (cloud provider managed service)

---

## 4. Application Deployment

### 4.1 External Secrets Operator

**Problem:** How to securely inject secrets into Kubernetes without storing them in Git?

**Solution:** External Secrets Operator syncs secrets from external providers (AWS Secrets Manager, Vault, etc.)

#### 4.1.1 Operator Installation

**File:** `kubernetes/argocd/apps/operators/external-secrets.yaml`

Deploys from Helm chart.

#### 4.1.2 SecretStore Configuration

**File:** `kubernetes/kustomize/shlink/secret-store.yaml`

```yaml
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
          role: "external-secrets-role"
          serviceAccountRef:
            name: external-secrets-sa
```

**Field Breakdown:**

**provider.vault.server**: Vault server URL
**provider.vault.path**: Vault secret engine path (e.g., `secret`)
**provider.vault.version**: KV secrets engine version (v1 or v2)
**auth.kubernetes**: Kubernetes authentication method configuration
**auth.kubernetes.mountPath**: Vault auth mount path (default: `kubernetes`)
**auth.kubernetes.role**: Vault role that grants access to secrets
**auth.kubernetes.serviceAccountRef**: ServiceAccount used for Vault authentication

**ServiceAccount for Vault Authentication:**
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets-sa
  namespace: shlink
```

**Note:** This uses Vault's Kubernetes auth method, where the ServiceAccount token is used to authenticate with Vault.

#### 4.1.3 ExternalSecret Resource

**File:** `kubernetes/kustomize/shlink/external-secret.yaml`

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: shlink-secrets
  namespace: shlink
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: shlink-db-credentials
    creationPolicy: Owner
  data:
    - secretKey: api-key
      remoteRef:
        key: shlink/data/api-key
        property: value
    - secretKey: db-password
      remoteRef:
        key: shlink/data/db-password
        property: value
```

**Field Breakdown:**

**refreshInterval: 1h**: Check Vault for updates every hour
**secretStoreRef**: Reference to SecretStore (defines provider)
**target.name**: Name of Kubernetes Secret to create
**target.creationPolicy: Owner**: ExternalSecret owns the Secret (deletes if ExternalSecret deleted)
**data[].secretKey**: Key in Kubernetes Secret
**data[].remoteRef.key**: Path in Vault (for KV v2, include `/data/` in the path)
**data[].remoteRef.property**: Property within the Vault secret (KV v2 stores secrets as JSON)

**What Gets Created:**
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: shlink-db-credentials
  namespace: shlink
type: Opaque
data:
  api-key: <base64-encoded-value>
  db-password: <base64-encoded-value>
```

**Sync Status:**
```bash
$ kubectl describe externalsecret -n shlink shlink-secrets
Status:
  Conditions:
    Status:  True
    Type:    SecretSynced
```

### 4.2 Shlink Deployment

**File:** `kubernetes/kustomize/shlink/deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shlink
  namespace: shlink
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
    spec:
      containers:
        - name: shlink
          image: shlinkio/shlink:stable
          ports:
            - containerPort: 8080
              name: http
          env:
            - name: DB_DRIVER
              value: postgres
            - name: DB_HOST
              value: shlink-db-primary.postgres.svc.cluster.local
            - name: DB_PORT
              value: "5432"
            - name: DB_NAME
              value: shlink
            - name: DB_USER
              value: shlink
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: shlink-db-pguser-shlink
                  key: password
            - name: DEFAULT_DOMAIN
              value: shlink.local
            - name: IS_HTTPS_ENABLED
              value: "false"
            - name: SHELL_VERBOSITY
              value: "3"
          livenessProbe:
            httpGet:
              path: /rest/health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /rest/health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

**Field Breakdown:**

**replicas: 3**: Three pods for high availability
**selector.matchLabels**: How Deployment finds its pods
**template.metadata.labels**: Labels applied to pods
**image: shlinkio/shlink:stable**: Official Shlink Docker image

**Environment Variables:**
- **DB_DRIVER**: Database type (postgres, mysql, maria)
- **DB_HOST**: PostgreSQL service DNS name
- **DB_PASSWORD.valueFrom.secretKeyRef**: Inject from Secret

**Probes:**

**livenessProbe**: "Is the pod alive?"
- If fails 3 times (`failureThreshold: 3`), Kubernetes restarts container
- Checks every 10 seconds (`periodSeconds: 10`)
- Waits 30 seconds after start before first check (`initialDelaySeconds: 30`)

**readinessProbe**: "Is the pod ready to receive traffic?"
- If fails 3 times, pod removed from Service endpoints (no traffic sent)
- Checks every 5 seconds
- Waits 10 seconds after start

**Why Different Delays?**
- Readiness: Quick check (10s) because we want to route traffic ASAP
- Liveness: Longer wait (30s) because restarting pod is expensive

**Resources:**
- **requests**: Scheduler guarantees this minimum (256Mi RAM, 0.1 CPU core)
- **limits**: Container killed if exceeds (512Mi RAM, 0.5 CPU core)

**CPU Units:**
- `100m` = 100 milliCPU = 0.1 CPU core
- `1000m` = 1 CPU core

### 4.3 Shlink Service

**File:** `kubernetes/kustomize/shlink/service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: shlink
  namespace: shlink
  labels:
    app: shlink
spec:
  type: ClusterIP
  selector:
    app: shlink
  ports:
    - port: 8080
      targetPort: 8080
      protocol: TCP
      name: http
```

**Field Breakdown:**

**type: ClusterIP**: Internal-only service (no external IP)
**selector.app: shlink**: Routes to pods with this label
**ports[].port: 8080**: Service listens on this port
**ports[].targetPort: 8080**: Forwards to container port

**Service DNS:**
```
shlink.shlink.svc.cluster.local:8080
│      │       │   │            │
│      │       │   │            └─ Port
│      │       │   └─ cluster.local (cluster domain)
│      │       └─ svc (service)
│      └─ namespace
└─ service name
```

**Traffic Flow:**
```
Client → shlink.shlink.svc.cluster.local:8080
   ↓
Service selects pods with label app=shlink
   ↓
Load balances across endpoints:
   - 10.42.0.20:8080 (shlink-xxxxx-1)
   - 10.42.1.15:8080 (shlink-xxxxx-2)
   - 10.42.2.10:8080 (shlink-xxxxx-3)
```

---

## 5. Service Mesh - Istio

### 5.1 Istio Installation

**What is a Service Mesh?**
A dedicated infrastructure layer for handling service-to-service communication. Provides observability, traffic management, and security without code changes.

**Istio Architecture:**
```
Control Plane (istiod)
├── Pilot (traffic management)
├── Citadel (certificate management)
└── Galley (configuration)

Data Plane (Envoy sidecars)
└── Injected into each pod
```

**Installation Command:**
```bash
istioctl install --set profile=default -y
```

**Default Profile Includes:**
- Istiod deployment (control plane)
- Istio Ingress Gateway (LoadBalancer)
- Envoy sidecar injection enabled

### 5.2 Sidecar Injection

**Enable for Namespace:**
```bash
kubectl label namespace shlink istio-injection=enabled
```

**What Happens:**
1. User creates pod via Deployment
2. Admission webhook intercepts pod creation
3. Istio mutates pod spec to add Envoy container
4. Pod runs with 2 containers: app + envoy-proxy

**Pod Before Injection:**
```yaml
spec:
  containers:
    - name: shlink
      image: shlinkio/shlink:stable
```

**Pod After Injection:**
```yaml
spec:
  initContainers:
    - name: istio-init  # Sets up iptables rules
  containers:
    - name: shlink
      image: shlinkio/shlink:stable
    - name: istio-proxy  # Envoy sidecar
      image: istio/proxyv2:1.24.2
```

**Init Container Purpose:**
Sets up iptables to redirect traffic:
```
Inbound traffic (port 8080)
   ↓
iptables redirect → Envoy (15006)
   ↓
Envoy forwards → shlink container (8080)
```

**Outbound traffic** also flows through Envoy for observability and policy enforcement.

### 5.3 Gateway Resource

**File:** `kubernetes/kustomize/shlink/gateway.yaml`

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: shlink-gateway
  namespace: shlink
spec:
  selector:
    istio: ingressgateway  # Use default Istio Ingress Gateway
  servers:
    - port:
        number: 80
        name: http
        protocol: HTTP
      hosts:
        - "*"
```

**Field Breakdown:**

**selector.istio: ingressgateway**: Bind to Istio Ingress Gateway pods
**servers[].port.number: 80**: Listen on HTTP port 80
**servers[].hosts: ["*"]**: Accept all hostnames

**What is This Gateway?**
The Gateway resource configures the Istio Ingress Gateway LoadBalancer. Think of it as Istio's version of Kubernetes Ingress.

### 5.4 VirtualService Resource

**File:** `kubernetes/kustomize/shlink/virtualservice.yaml`

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: shlink
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

**Field Breakdown:**

**hosts: ["*"]**: Match all hostnames
**gateways**: Bind to shlink-gateway (from Gateway resource)
**http[].match[].uri.prefix: /**: Match all paths
**http[].route[].destination.host**: Route to Shlink service

**Traffic Flow:**
```
Client: http://192.168.2.242/abc
   ↓
Istio Ingress Gateway (LoadBalancer)
   ↓
Gateway resource: Accept HTTP on port 80
   ↓
VirtualService: Route / → shlink.shlink.svc.cluster.local:8080
   ↓
Shlink Service selects pod
   ↓
Envoy sidecar intercepts
   ↓
Shlink container
```

### 5.5 Istio Telemetry Configuration

**File:** `kubernetes/kustomize/istio-telemetry/telemetry.yaml`

```yaml
apiVersion: telemetry.istio.io/v1alpha1
kind: Telemetry
metadata:
  name: mesh-default
  namespace: istio-system
spec:
  tracing:
    - providers:
        - name: jaeger
      randomSamplingPercentage: 100.0
      customTags:
        environment:
          literal:
            value: "k3s-lab"
        cluster:
          literal:
            value: "url-shortener"
```

**Field Breakdown:**

**tracing.providers[].name: jaeger**: Send traces to Jaeger
**randomSamplingPercentage: 100.0**: Sample all requests (100%)
**customTags**: Add metadata to every trace

**Sampling Percentage:**
- `100.0`: Sample every request (development/debugging)
- `1.0`: Sample 1% (production - reduces overhead)
- `10.0`: Sample 10%

**Custom Tags:**
Added to every trace span for filtering:
```
environment=k3s-lab
cluster=url-shortener
```

**Provider Configuration (Extension):**
```yaml
# In istio ConfigMap
extensionProviders:
  - name: jaeger
    zipkin:
      service: jaeger-collector.observability.svc.cluster.local
      port: 9411
```

This tells Envoy sidecars where to send trace data.

### 5.6 Istio Monitoring - ServiceMonitors

**File:** `kubernetes/kustomize/istio-monitoring/servicemonitor-*.yaml`

**Purpose:** Tell Prometheus which Istio components to scrape for metrics.

**ServiceMonitor for Istiod:**
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: servicemonitor-istiod
  namespace: istio-system
  labels:
    release: prometheus-stack
spec:
  selector:
    matchLabels:
      app: istiod
  endpoints:
    - port: http-monitoring
      interval: 15s
```

**Field Breakdown:**

**labels.release: prometheus-stack**: Prometheus operator filters by this label
**selector.matchLabels.app: istiod**: Select istiod service
**endpoints[].port: http-monitoring**: Scrape this port
**endpoints[].interval: 15s**: Scrape every 15 seconds

**ServiceMonitor for Ingress Gateway:**
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: servicemonitor-ingressgateway
  namespace: istio-system
  labels:
    release: prometheus-stack
spec:
  selector:
    matchLabels:
      app: istio-ingressgateway
  endpoints:
    - port: http-envoy-prom
      path: /stats/prometheus
      interval: 15s
```

**Envoy Metrics Path:** `/stats/prometheus`
- Request counts
- Latency histograms (p50, p90, p95, p99)
- Error rates
- Active connections

**PodMonitor for All Envoy Sidecars:**
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: podmonitor-envoy-stats
  namespace: istio-system
  labels:
    release: prometheus-stack
spec:
  selector:
    matchExpressions:
      - key: istio.io/rev
        operator: Exists
  namespaceSelector:
    any: true
  podMetricsEndpoints:
    - port: http-envoy-prom
      path: /stats/prometheus
      interval: 15s
```

**Why PodMonitor Instead of ServiceMonitor?**
Envoy sidecars don't have their own service. PodMonitor directly scrapes pods matching a label selector.

**selector.matchExpressions**: Pods with label `istio.io/rev` (injected by Istio)
**namespaceSelector.any: true**: Scrape all namespaces

---

## 6. Observability Stack

### 6.1 Prometheus Stack (kube-prometheus-stack)

**What is kube-prometheus-stack?**
Helm chart bundling Prometheus, Grafana, Alertmanager, and related components.

**File:** `kubernetes/argocd/apps/observability/prometheus-stack.yaml`

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: prometheus-stack
  namespace: argocd
spec:
  source:
    repoURL: https://prometheus-community.github.io/helm-charts
    chart: kube-prometheus-stack
    targetRevision: 45.0.0
    helm:
      values: |
        prometheus:
          prometheusSpec:
            serviceMonitorSelectorNilUsesHelmValues: false
            podMonitorSelectorNilUsesHelmValues: false
            serviceMonitorSelector:
              matchLabels:
                release: prometheus-stack
            podMonitorSelector:
              matchLabels:
                release: prometheus-stack
            retention: 10d
            storageSpec:
              volumeClaimTemplate:
                spec:
                  accessModes:
                    - ReadWriteOnce
                  resources:
                    requests:
                      storage: 5Gi
        grafana:
          service:
            type: LoadBalancer
            port: 3000
          persistence:
            enabled: true
            size: 5Gi
          adminPassword: admin
```

**Critical Fields:**

**serviceMonitorSelectorNilUsesHelmValues: false**
- Default: Only scrape ServiceMonitors created by this Helm release
- `false`: Scrape ALL ServiceMonitors matching `matchLabels`

**serviceMonitorSelector.matchLabels.release: prometheus-stack**
- Scrape ServiceMonitors with label `release=prometheus-stack`
- This is why all our ServiceMonitors have this label!

**retention: 10d**: Keep metrics for 10 days

**storageSpec**: PVC for storing metrics (5Gi)

**grafana.service.type: LoadBalancer**: Expose Grafana externally

**grafana.service.port: 3000**: Avoid port 80 conflict with Istio

### 6.2 Grafana Dashboards

**How Dashboards Get Loaded:**
1. Helm chart includes ConfigMaps with dashboard JSON
2. Grafana imports dashboards from ConfigMaps on startup
3. Dashboards stored in Grafana database (SQLite)

**Istio Dashboards Included:**
- Istio Control Plane Dashboard
- Istio Mesh Dashboard
- Istio Service Dashboard
- Istio Workload Dashboard

**Accessing Dashboards:**
```
URL: http://192.168.2.242:3000
Credentials: admin / admin
Navigate: Dashboards → Browse → Istio
```

**Key Metrics in Istio Service Dashboard:**
- **Request Volume**: ops/sec
- **Success Rate**: % of 2xx/3xx responses
- **Request Duration P50**: Median latency
- **Request Duration P90**: 90th percentile
- **Request Duration P99**: 99th percentile (slow requests)

### 6.3 Jaeger (Distributed Tracing)

**File:** `kubernetes/kustomize/jaeger/jaeger-all-in-one.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: observability
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: jaeger
          image: jaegertracing/all-in-one:1.53
          env:
            - name: COLLECTOR_ZIPKIN_HOST_PORT
              value: ":9411"
          ports:
            - containerPort: 16686  # UI
            - containerPort: 14250  # gRPC collector
            - containerPort: 4317   # OTLP HTTP
            - containerPort: 9411   # Zipkin
            - containerPort: 6831   # Thrift
```

**all-in-one Image:**
Bundles collector, query, and UI in single container (development use).

**Ports:**
- **16686**: Web UI (Jaeger Query)
- **14250**: gRPC collector (Istio uses this)
- **4317**: OTLP HTTP (OpenTelemetry Protocol)
- **9411**: Zipkin compatibility (Istio can use this)

**Service:**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: jaeger-collector
  namespace: observability
spec:
  type: ClusterIP
  ports:
    - port: 4317
      name: otlp-http
    - port: 9411
      name: zipkin
```

**Istio Integration:**
Istio mesh config points Envoy sidecars to:
```
jaeger-collector.observability.svc.cluster.local:4317
```

Envoy automatically sends trace spans using OTLP protocol.

### 6.4 Kiali (Service Mesh Visualization)

**File:** `kubernetes/kustomize/kiali/kiali-cr.yaml`

```yaml
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: observability
spec:
  auth:
    strategy: anonymous
  external_services:
    prometheus:
      url: http://prometheus-stack-kube-prom-prometheus.observability:9090
    grafana:
      url: http://prometheus-stack-grafana.observability:3000
      in_cluster_url: http://prometheus-stack-grafana.observability:80
    tracing:
      enabled: true
      in_cluster_url: http://jaeger-query.observability:16686
      url: http://192.168.2.242:16686
  deployment:
    accessible_namespaces:
      - '**'
    service_type: LoadBalancer
```

**Field Breakdown:**

**auth.strategy: anonymous**: No login required (homelab)
**external_services.prometheus.url**: Where Kiali queries metrics
**external_services.grafana**: Links to Grafana dashboards
**external_services.tracing**: Links to Jaeger traces
**deployment.accessible_namespaces: ['**']**: Monitor all namespaces
**deployment.service_type: LoadBalancer**: External access

**Kiali Features:**
1. **Service Graph**: Visual topology with traffic flows
2. **Traffic Metrics**: Request rates, latencies from Prometheus
3. **Health Indicators**: Green/yellow/red based on error rates
4. **Trace Sampling**: Click on request to view Jaeger trace

---

## 7. Load Testing

### 7.1 k6 Test Scenarios

**Why k6?**
- Modern load testing tool (JavaScript-based)
- Built-in metrics and thresholds
- Supports realistic traffic patterns (ramp-up, ramp-down)
- Integrates with Prometheus, Grafana, InfluxDB

### 7.2 Scenario Structure

**File:** `load-tests/scenario1-baseline.js`

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

// Custom metrics
const urlCreationDuration = new Trend('url_creation_duration');
const redirectDuration = new Trend('redirect_duration');

export const options = {
  stages: [
    { duration: '1m', target: 10 },   // Ramp up
    { duration: '8m', target: 10 },   // Steady state
    { duration: '1m', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<100', 'p(99)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  // Pre-create URLs for redirect testing
  const urls = [];
  for (let i = 0; i < 100; i++) {
    const res = http.post(
      `${__ENV.BASE_URL}/rest/v3/short-urls`,
      JSON.stringify({
        longUrl: `https://example.com/page-${i}`,
        domain: __ENV.DEFAULT_DOMAIN,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': __ENV.SHLINK_API_KEY,
        },
      }
    );
    urls.push(JSON.parse(res.body).shortCode);
  }
  return { urls };
}

export default function (data) {
  // 95% redirects, 5% creations (read-heavy)
  if (Math.random() < 0.95) {
    // Redirect test
    const shortCode = data.urls[Math.floor(Math.random() * data.urls.length)];
    const res = http.get(`${__ENV.BASE_URL}/${shortCode}`, {
      redirects: 0,  // Don't follow redirect
    });
    check(res, { 'redirect status 302': (r) => r.status === 302 });
    redirectDuration.add(res.timings.duration);
  } else {
    // URL creation test
    const res = http.post(
      `${__ENV.BASE_URL}/rest/v3/short-urls`,
      JSON.stringify({
        longUrl: `https://example.com/test-${Date.now()}`,
        domain: __ENV.DEFAULT_DOMAIN,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': __ENV.SHLINK_API_KEY,
        },
      }
    );
    check(res, { 'creation status 200': (r) => r.status === 200 });
    urlCreationDuration.add(res.timings.duration);
  }

  sleep(1);  // Think time
}
```

**Key Concepts:**

**stages**: Load profile over time
- Ramp up to 10 VUs (virtual users) over 1 minute
- Hold 10 VUs for 8 minutes
- Ramp down to 0 over 1 minute

**thresholds**: Pass/fail criteria
- `p(95)<100`: 95th percentile response time < 100ms
- `http_req_failed: rate<0.01`: Error rate < 1%

**Custom Metrics:**
```javascript
const urlCreationDuration = new Trend('url_creation_duration');
urlCreationDuration.add(res.timings.duration);
```
Tracks URL creation latency separately from redirects.

**setup() Function:**
Runs once before test. Pre-creates 100 URLs for realistic redirect testing.

**default() Function:**
Runs for each VU iteration. 95% redirects, 5% creations (mimics production).

### 7.3 Running Tests

**Environment Variables:**
```bash
export BASE_URL="http://192.168.2.242"
export SHLINK_API_KEY="<your-api-key>"
export DEFAULT_DOMAIN="shlink.local"
```

**Execute Test:**
```bash
k6 run --env BASE_URL=$BASE_URL \
  --env SHLINK_API_KEY=$SHLINK_API_KEY \
  --env DEFAULT_DOMAIN=$DEFAULT_DOMAIN \
  scenario1-baseline.js
```

**Output:**
```
     data_received..................: 1.2 MB  2.0 kB/s
     data_sent......................: 450 kB  750 B/s
     http_req_duration..............: avg=28ms min=10ms med=25ms max=80ms p(95)=45ms p(99)=60ms
     http_req_failed................: 0.00%
     url_creation_duration..........: avg=39ms min=20ms med=35ms max=90ms p(95)=55ms p(99)=70ms
     redirect_duration..............: avg=27ms min=10ms med=24ms max=75ms p(95)=42ms p(99)=58ms
```

---

## 8. Configuration Patterns

### 8.1 Kustomize Basics

**What is Kustomize?**
Template-free Kubernetes manifest customization. Composes YAML files without string templating.

**Directory Structure:**
```
kubernetes/kustomize/shlink/
├── kustomization.yaml
├── deployment.yaml
├── service.yaml
├── gateway.yaml
└── virtualservice.yaml
```

**kustomization.yaml:**
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shlink
resources:
  - deployment.yaml
  - service.yaml
  - gateway.yaml
  - virtualservice.yaml
commonLabels:
  app: shlink
```

**Build Manifests:**
```bash
kubectl kustomize kubernetes/kustomize/shlink/
```

**Output:** All resources merged with `namespace: shlink` and `app: shlink` labels added.

### 8.2 Label Selectors

**Purpose:** Connect resources

**Deployment → Pods:**
```yaml
# Deployment
spec:
  selector:
    matchLabels:
      app: shlink
  template:
    metadata:
      labels:
        app: shlink
```

**Service → Pods:**
```yaml
# Service
spec:
  selector:
    app: shlink
```

**ServiceMonitor → Service:**
```yaml
# ServiceMonitor
spec:
  selector:
    matchLabels:
      app: istiod
```

**Rule:** Labels must match for resources to connect.

### 8.3 Environment Variable Injection

**Direct Value:**
```yaml
env:
  - name: DB_DRIVER
    value: postgres
```

**From Secret:**
```yaml
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: shlink-db-pguser-shlink
        key: password
```

**From ConfigMap:**
```yaml
env:
  - name: CONFIG_FILE
    valueFrom:
      configMapKeyRef:
        name: app-config
        key: config.json
```

### 8.4 Resource Requests vs Limits

**Requests:** Guaranteed minimum
**Limits:** Maximum allowed

```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "100m"
  limits:
    memory: "512Mi"
    cpu: "500m"
```

**Scheduler Behavior:**
- Node must have 256Mi available RAM to schedule pod
- Pod guaranteed 256Mi (won't be OOM killed below this)
- Pod can burst up to 512Mi
- If exceeds 512Mi, pod killed (OOMKilled)

**CPU Throttling:**
- Pod can use up to 500m (0.5 cores)
- If tries to use more, throttled (not killed)

### 8.5 StatefulSet vs Deployment

**Deployment:**
- Pods are interchangeable (cattle)
- Random pod names: `shlink-5d6f7b8c9d-xyz12`
- Any pod can be deleted/recreated
- Use for stateless apps

**StatefulSet:**
- Pods have stable identity (pets)
- Predictable names: `postgres-0`, `postgres-1`, `postgres-2`
- Pods created in order (0 → 1 → 2)
- Each pod gets dedicated PVC
- Use for databases, caches

**Example StatefulSet:**
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres-headless
  replicas: 3
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 20Gi
```

**Creates:**
```
Pod: postgres-0 → PVC: data-postgres-0
Pod: postgres-1 → PVC: data-postgres-1
Pod: postgres-2 → PVC: data-postgres-2
```

---

## Summary

This deep dive covered:

1. **K3s Infrastructure**: How the cluster runs on Proxmox VMs, networking, storage
2. **GitOps with ArgoCD**: App-of-apps pattern, automated sync, Application structure
3. **Data Layer**: PostgreSQL operator, Redis Sentinel, permission gotchas
4. **Application**: External Secrets, Deployment, Service, probes
5. **Service Mesh**: Istio injection, Gateway, VirtualService, telemetry
6. **Observability**: Prometheus scraping, Grafana dashboards, Jaeger tracing, Kiali visualization
7. **Load Testing**: k6 scenarios, realistic traffic modeling
8. **Patterns**: Kustomize, labels, resources, StatefulSet vs Deployment

**Next Steps:**
- Read through actual YAML files with this guide as reference
- Modify configurations and observe results
- Practice troubleshooting by intentionally breaking things

**Questions to Explore:**
1. What happens if you delete a pod? How does it recover?
2. How would you scale Shlink to 5 replicas?
3. What if you change a Deployment and ArgoCD reverts it?
4. How does traffic flow through Istio vs direct to Service?
5. Why does Prometheus need the `release=prometheus-stack` label?

Use this guide to build deep understanding. The best way to learn is to experiment!
